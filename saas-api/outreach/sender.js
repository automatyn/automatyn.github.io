// Unified sender for Email 1, Email 2, Email 3.
//
// Usage:
//   node sender.js e1 [limit]   — send Email 1 to next N ready leads
//   node sender.js e2 [limit]   — send Email 2 to leads past Day 3
//   node sender.js e3 [limit]   — send Email 3 to leads past Day 5
//   node sender.js dry e1 [limit] — render without sending
//
// Requires env:
//   BREVO_API_KEY        — Brevo transactional API key
//   UNSUBSCRIBE_SECRET   — HMAC secret for unsub token
//
// Daily caps (hard-stop):
//   E1: 15/day week 1 → 30/day week 2 (controlled via OUTREACH_DAILY_CAP env, default 15)
//   E2/E3: follow-ups are not capped (they go to people who already got E1)
//
// Sender identity: "Patrick from Automatyn <patrick@automatyn.co>", Reply-To routes
// through Cloudflare Email Routing → Gmail inbox. Outbound sends do NOT appear in
// Gmail Sent folder — check Brevo dashboard (app.brevo.com/statistics/transactional)
// for delivery logs.

const https = require('https');
const crypto = require('crypto');
const store = require('./leads-store');
const { buildEmail } = require('./templates');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.OUTREACH_SENDER_EMAIL || 'patrick@automatyn.co';
const SENDER_NAME = process.env.OUTREACH_SENDER_NAME || 'Patrick from Automatyn';
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'automatyn-unsub-2026-04-19';
const DAILY_CAP = parseInt(process.env.OUTREACH_DAILY_CAP, 10) || 15;

function unsubToken(email) {
  return crypto.createHmac('sha256', UNSUBSCRIBE_SECRET).update(email.toLowerCase()).digest('hex').slice(0, 16);
}

function makeTransport() {
  if (!BREVO_API_KEY) {
    throw new Error('BREVO_API_KEY not set. Add it to systemd Environment= and restart automatyn-api.service.');
  }
  return { sendMail: sendViaBrevo };
}

function sendViaBrevo({ from, to, subject, text, headers }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      replyTo: { email: SENDER_EMAIL, name: SENDER_NAME.replace(/ from Automatyn$/, '') },
      to: [{ email: to }],
      subject,
      textContent: text,
      headers: headers || {},
    });
    const req = https.request('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json',
      },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve({ messageId: JSON.parse(d).messageId }); }
          catch { resolve({ messageId: 'unknown' }); }
        } else {
          reject(new Error(`Brevo ${res.statusCode}: ${d}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Brevo timeout')); });
    req.write(body);
    req.end();
  });
}

function pickQueue(step) {
  if (step === 1) return store.listReadyForEmail1(Infinity);
  if (step === 2) return store.listReadyForEmail2(Infinity, 3);
  if (step === 3) return store.listReadyForEmail3(Infinity, 5);
  throw new Error('step must be 1, 2, or 3');
}

function sentTodayCount(step) {
  const key = step === 1 ? 'email1_sent' : step === 2 ? 'email2_sent' : 'email3_sent';
  const today = new Date().toISOString().slice(0, 10);
  return store.listAll().filter(l => l[key] && l[key].slice(0, 10) === today).length;
}

async function sendOne(transport, lead, step, dryRun) {
  const token = unsubToken(lead.email);
  const { subject, body } = buildEmail(step, lead, token);
  if (dryRun) {
    console.log('---');
    console.log(`TO: ${lead.email}`);
    console.log(`SUBJECT: ${subject}`);
    console.log(body);
    return { ok: true, dry: true };
  }
  const info = await transport.sendMail({
    to: lead.email,
    subject,
    text: body,
    headers: {
      'List-Unsubscribe': `<https://api.automatyn.co/u?e=${encodeURIComponent(lead.email)}&t=${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
  const now = new Date().toISOString();
  const patch = step === 1 ? { email1_sent: now } : step === 2 ? { email2_sent: now } : { email3_sent: now };
  store.update(lead.id, patch);
  return { ok: true, messageId: info.messageId };
}

async function run(step, limit, dryRun) {
  const queue = pickQueue(step);
  let max = limit === Infinity ? queue.length : limit;

  if (step === 1 && !dryRun) {
    const already = sentTodayCount(1);
    const remaining = Math.max(0, DAILY_CAP - already);
    if (remaining === 0) {
      console.log(`Daily cap reached: ${already}/${DAILY_CAP} Email 1 sent today. Stop.`);
      return;
    }
    max = Math.min(max, remaining);
    console.log(`Sent today: ${already}/${DAILY_CAP}. Sending up to ${max} more.`);
  }

  const slice = queue.slice(0, max);
  console.log(`Email ${step}: ${slice.length} lead(s) to send${dryRun ? ' (DRY RUN)' : ''}`);
  if (!slice.length) return;

  const transport = dryRun ? null : makeTransport();
  if (!dryRun) console.log('Using Brevo transactional API.');

  let sent = 0, failed = 0;
  for (const lead of slice) {
    try {
      await sendOne(transport, lead, step, dryRun);
      sent++;
      console.log(`  ✓ ${lead.email} (${lead.business_name})`);
      if (!dryRun) await sleep(jitter(45000, 90000)); // 45-90s between sends
    } catch (err) {
      failed++;
      console.error(`  ✗ ${lead.email}: ${err.message}`);
      // Mark bounce if SMTP says so
      if (/550|bounce|no such user|does not exist/i.test(err.message)) {
        store.update(lead.id, { bounced: true });
      }
    }
  }
  console.log(`Done. Sent ${sent}, failed ${failed}.`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(a, b) { return a + Math.floor(Math.random() * (b - a)); }

function parseStep(tok) {
  if (tok === 'e1') return 1;
  if (tok === 'e2') return 2;
  if (tok === 'e3') return 3;
  return null;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dry = args[0] === 'dry';
  const stepTok = dry ? args[1] : args[0];
  const step = parseStep(stepTok);
  if (!step) {
    console.error('Usage: sender.js <e1|e2|e3> [limit]');
    console.error('       sender.js dry <e1|e2|e3> [limit]');
    process.exit(1);
  }
  const limit = parseInt(dry ? args[2] : args[1], 10) || 15;
  run(step, limit, dry).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run, unsubToken };
