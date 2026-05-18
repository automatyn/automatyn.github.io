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

require('./load-env'); // load /etc/automatyn-api.env for ad-hoc CLI runs (no-op under systemd)

const https = require('https');
const crypto = require('crypto');
const store = require('./leads-store');
// Template version dispatch. Set EMAIL_TEMPLATE_VERSION=v6 to use the rewritten
// templates (single-question CTA, no link in E1). Defaults to v5 (templates.js)
// for backwards compat with existing automation.
const TEMPLATE_VERSION = process.env.EMAIL_TEMPLATE_VERSION || 'v5';
const _templates = TEMPLATE_VERSION === 'v6' ? require('./templates-v6') : require('./templates');
const { buildEmail, SUBJECTS_E1, CTAS_E1, pickVariantRoundRobin } = _templates;
const { buildSummerEmail, SUBJECTS: SUMMER_SUBJECTS } = require('./templates-summer');

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

const GENERIC_LOCAL_PARTS = new Set([
  'info', 'sales', 'contact', 'enquiries', 'enquiry', 'hello', 'admin',
  'office', 'reception', 'support', 'mail', 'general',
]);

function isGenericMailbox(email) {
  if (!email) return false;
  const local = email.split('@')[0].toLowerCase();
  return GENERIC_LOCAL_PARTS.has(local);
}

const PLACEHOLDER_LOCAL_PARTS = new Set([
  'you', 'your', 'example', 'user', 'name', 'email', 'test',
  'webmaster', 'server', 'hostmaster', 'postmaster',
  'noreply', 'no-reply', 'mailer-daemon', 'donotreply', 'abuse',
]);

function isUnsendable(email) {
  if (!email) return true;
  if (typeof email !== 'string') return true;
  const trimmed = email.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return true;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  const local = trimmed.split('@')[0].toLowerCase();
  if (PLACEHOLDER_LOCAL_PARTS.has(local)) return true;
  return false;
}

function preferNamed(queue) {
  const sendable = queue.filter(l => {
    if (isUnsendable(l.email)) {
      try { store.update(l.id, { do_not_send: true, do_not_send_reason: 'placeholder_or_invalid_email' }); } catch {}
      return false;
    }
    if (l.do_not_send) return false;
    return true;
  });
  return sendable.slice().sort((a, b) => {
    const ag = isGenericMailbox(a.email) ? 1 : 0;
    const bg = isGenericMailbox(b.email) ? 1 : 0;
    return ag - bg;
  });
}

function pickQueue(step) {
  if (step === 1) return preferNamed(store.listReadyForEmail1(Infinity));
  if (step === 2) return preferNamed(store.listReadyForEmail2(Infinity, 3));
  if (step === 3) return preferNamed(store.listReadyForEmail3(Infinity, 5));
  throw new Error('step must be 1, 2, or 3');
}

function sentTodayCount(step) {
  const key = step === 1 ? 'email1_sent' : step === 2 ? 'email2_sent' : 'email3_sent';
  const today = new Date().toISOString().slice(0, 10);
  return store.listAll().filter(l => l[key] && l[key].slice(0, 10) === today).length;
}

// Deterministic variant assignment: hash lead id into subject + CTA bucket,
// independent axes so we get coverage on both. Recorded on the lead for
// per-variant attribution in daily-report.js.
//
// Skips pairs marked dead by monitor.js — re-rolls with a salt until a live
// pair lands. If all pairs are dead, falls back to first defined pair (so we
// keep sending even if the monitor went rogue).
function loadDeadVariants() {
  try {
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'dead-variants.json'), 'utf8'));
  } catch { return {}; }
}

function assignE1Variants(leadId) {
  const dead = loadDeadVariants();
  for (let salt = 0; salt < 16; salt++) {
    const h = crypto.createHash('sha1').update(leadId + ':' + salt).digest();
    const subjectId = pickVariantRoundRobin(SUBJECTS_E1, h[0]);
    const ctaId = pickVariantRoundRobin(CTAS_E1, h[1]);
    const key = `${subjectId}|${ctaId}`;
    if (!dead[key]) return { subjectId, ctaId };
  }
  // Everything dead — fall back to first defined.
  const subjectId = Object.keys(SUBJECTS_E1)[0];
  const ctaId = Object.keys(CTAS_E1)[0];
  return { subjectId, ctaId };
}

async function sendOne(transport, lead, step, dryRun) {
  if (isUnsendable(lead.email)) {
    try { store.update(lead.id, { do_not_send: true, do_not_send_reason: 'placeholder_or_invalid_email' }); } catch {}
    throw new Error(`unsendable email: ${JSON.stringify(lead.email)}`);
  }
  const token = unsubToken(lead.email);
  // Summer-niche routing: if lead is gardener/tree-surgeon/roofer AND this is E1,
  // use templates-summer.js (E2/E3 still use plumber templates for now).
  const summerNiche = SUMMER_SUBJECTS[lead.source_vertical] ? lead.source_vertical : null;
  let built;
  if (step === 1 && summerNiche) {
    const unsubUrl = `https://api.automatyn.co/u?e=${encodeURIComponent(lead.email)}&t=${encodeURIComponent(token)}`;
    const h = crypto.createHash('sha1').update(lead.id).digest();
    const subjectIdx = h[0] % 3;
    built = buildSummerEmail(summerNiche, lead, unsubUrl, subjectIdx);
    built.ctaId = `summer-v1-${summerNiche}`;
  } else {
    const opts = step === 1 ? assignE1Variants(lead.id) : {};
    built = buildEmail(step, lead, token, opts);
  }
  const { subject, body } = built;
  if (dryRun) {
    console.log('---');
    console.log(`TO: ${lead.email}`);
    if (step === 1) console.log(`VARIANTS: subject=${built.subjectId} cta=${built.ctaId}`);
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
  const msgIdKey = step === 1 ? 'email1_message_id' : step === 2 ? 'email2_message_id' : 'email3_message_id';
  const patch = step === 1 ? { email1_sent: now } : step === 2 ? { email2_sent: now } : { email3_sent: now };
  patch[msgIdKey] = info.messageId || null;
  if (step === 1) {
    patch.e1_subject_id = built.subjectId;
    patch.e1_cta_id = built.ctaId;
  }
  store.update(lead.id, patch);
  return { ok: true, messageId: info.messageId };
}

async function run(step, limit, dryRun) {
  const fs = require('fs');
  const path = require('path');
  // monitor.js writes outreach/HALT on bounce/spam alarms. Respect it.
  if (!dryRun) {
    try {
      const haltPath = path.join(__dirname, 'HALT');
      if (fs.existsSync(haltPath)) {
        const reason = fs.readFileSync(haltPath, 'utf8');
        console.error('SENDS HALTED by monitor.js:\n' + reason);
        console.error('Remove outreach/HALT to resume.');
        return;
      }
    } catch {}
  }

  // Per-step concurrency lock: prevent two parallel sender runs for the same
  // step from double-sending the same leads. Different steps (e1/e2/e3) can
  // still run in parallel — they touch disjoint queues.
  const lockPath = path.join(__dirname, `sender-step${step}.lock`);
  let lockFd = null;
  if (!dryRun) {
    try {
      // O_CREAT | O_EXCL fails if file exists — atomic acquire
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, step, startedAt: new Date().toISOString() }));
    } catch (err) {
      if (err.code === 'EEXIST') {
        const stale = fs.readFileSync(lockPath, 'utf8');
        let staleInfo = {};
        try { staleInfo = JSON.parse(stale); } catch {}
        // Detect stale lock: if pid is dead, take it over
        let alive = false;
        if (staleInfo.pid) {
          try { process.kill(staleInfo.pid, 0); alive = true; }
          catch (e) { alive = (e.code === 'EPERM'); }
        }
        if (alive) {
          console.error(`Another sender for step ${step} is running (pid ${staleInfo.pid}, started ${staleInfo.startedAt}). Skipping.`);
          return;
        }
        console.warn(`Stale lock from dead pid ${staleInfo.pid}; reclaiming.`);
        fs.unlinkSync(lockPath);
        lockFd = fs.openSync(lockPath, 'wx');
        fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, step, startedAt: new Date().toISOString() }));
      } else {
        throw err;
      }
    }
  }
  const releaseLock = () => {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
      lockFd = null;
    }
  };
  // Ensure lock is released on any process exit signal
  process.once('SIGINT',  () => { releaseLock(); process.exit(130); });
  process.once('SIGTERM', () => { releaseLock(); process.exit(143); });
  process.once('exit',    () => { releaseLock(); });
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
  releaseLock();
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
