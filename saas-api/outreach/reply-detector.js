// Reply detector — polls Gmail inbox for messages from leads.
// When a lead replies, mark replied=true so follow-ups stop.
//
// Uses Gmail API (OAuth). Credentials live on disk at saas-api/secrets/
// (gitignored). If either file is missing, script self-skips cleanly.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const store = require('./leads-store');

const CLIENT_PATH = path.join(__dirname, '..', 'secrets', 'gmail-oauth-client.json');
const TOKEN_PATH = path.join(__dirname, '..', 'secrets', 'gmail-token.json');

function loadCreds() {
  if (!fs.existsSync(CLIENT_PATH) || !fs.existsSync(TOKEN_PATH)) return null;
  const c = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf8')).installed;
  const t = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  return { client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token };
}

async function gmailClient(creds) {
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  oauth2.setCredentials({ refresh_token: creds.refresh_token });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

// Bounce detection: Gmail flags bounces from mailer-daemon with a failed-recipient header.
function extractFailedRecipient(headers, snippet) {
  const h = (name) => (headers.find(x => x.name.toLowerCase() === name.toLowerCase()) || {}).value || '';
  const xFailed = h('X-Failed-Recipients');
  if (xFailed) return xFailed.trim();
  // Fallback: pull first email from snippet
  const m = snippet && snippet.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return m ? m[1] : null;
}

async function run(lookbackHours = 24) {
  const creds = loadCreds();
  if (!creds) {
    console.log('Gmail OAuth creds not found at saas-api/secrets/. Run seo/gmail-auth flow.');
    return;
  }
  const gmail = await gmailClient(creds);
  const afterTs = Math.floor((Date.now() - lookbackHours * 3600 * 1000) / 1000);
  const q = `in:inbox after:${afterTs}`;
  let replyCount = 0, bounceCount = 0;

  const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100 });
  const msgs = list.data.messages || [];
  console.log(`Scanning ${msgs.length} inbox messages...`);

  for (const { id } of msgs) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'X-Failed-Recipients', 'Auto-Submitted'] });
    const headers = msg.data.payload.headers || [];
    const fromHdr = (headers.find(h => h.name === 'From') || {}).value || '';
    const subj = (headers.find(h => h.name === 'Subject') || {}).value || '';
    const fromEmailMatch = fromHdr.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    const fromEmail = fromEmailMatch ? fromEmailMatch[1].toLowerCase() : null;
    if (!fromEmail) continue;

    // Bounce? mailer-daemon, delivery failure, etc.
    const isBounce = /mailer-daemon|postmaster@/i.test(fromHdr) || /delivery\s*(status|failure)|returned mail|undeliver/i.test(subj);
    if (isBounce) {
      const failed = extractFailedRecipient(headers, msg.data.snippet);
      if (failed) {
        const lead = store.findByEmail(failed);
        if (lead && !lead.bounced) {
          store.update(lead.id, { bounced: true });
          bounceCount++;
          console.log(`  ✗ bounce: ${failed} (${lead.business_name})`);
        }
      }
      continue;
    }

    // Reply? from matches a lead's email
    const lead = store.findByEmail(fromEmail);
    if (lead && !lead.replied) {
      store.update(lead.id, { replied: true });
      replyCount++;
      console.log(`  ✓ reply from ${fromEmail} (${lead.business_name}) — "${subj}"`);
    }
  }
  console.log(`Done. Replies: ${replyCount}, bounces: ${bounceCount}.`);
}

if (require.main === module) {
  const hours = parseInt(process.argv[2], 10) || 24;
  run(hours).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
