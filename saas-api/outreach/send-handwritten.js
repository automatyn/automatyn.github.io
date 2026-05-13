#!/usr/bin/env node
// One-off sender for hand-written outreach emails. Bypasses templates.js,
// sends via Brevo using the same sender identity as sender.js, marks each
// lead as email1_sent with variant='v4_handwritten' for separate tracking.
//
// Usage: BREVO_API_KEY=... UNSUBSCRIBE_SECRET=... node send-handwritten.js <path-to-emails.json>

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const store = require('./leads-store');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || 'automatyn-unsub-2026-04-19';
if (!BREVO_API_KEY) { console.error('BREVO_API_KEY required'); process.exit(1); }

const SENDER_EMAIL = process.env.OUTREACH_SENDER_EMAIL || 'patrick@automatyn.co';
const SENDER_NAME = process.env.OUTREACH_SENDER_NAME || 'Patrick from Automatyn';
const APP_URL = 'https://automatyn.co';

function unsubToken(email) {
  return crypto.createHmac('sha256', UNSUBSCRIBE_SECRET).update(email.toLowerCase()).digest('hex').slice(0, 16);
}

function sendViaBrevo({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      replyTo: { email: SENDER_EMAIL, name: 'Pat' },
      to: [{ email: to }],
      subject,
      textContent: text,
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
          try { resolve({ ok: true, messageId: JSON.parse(d).messageId }); }
          catch { resolve({ ok: true, messageId: 'unknown' }); }
        } else {
          resolve({ ok: false, status: res.statusCode, body: d.slice(0, 300) });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Brevo timeout')); });
    req.write(body);
    req.end();
  });
}

async function run() {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node send-handwritten.js <emails.json>'); process.exit(1); }
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Sending ${list.length} hand-written emails (variant=v4_handwritten)`);

  let sent = 0, failed = 0;
  for (const e of list) {
    // Append unsubscribe link
    const unsubUrl = `${APP_URL}/unsubscribe?e=${encodeURIComponent(e.to)}&t=${unsubToken(e.to)}`;
    const body = `${e.body}\n\n\n---\nDon't want emails from us: ${unsubUrl}`;

    const r = await sendViaBrevo({ to: e.to, subject: e.subject, text: body });
    if (r.ok) {
      // Mark in lead store
      store.update(e.id, {
        email1_sent: new Date().toISOString(),
        email1_message_id: r.messageId,
        e1_variant: 'v4_handwritten',
        e1_subject_id: 'v4_hw',
        e1_cta_id: 'v4_hw',
      });
      sent++;
      console.log(`  ✓ ${e.to} (${e.business})`);
    } else {
      failed++;
      console.log(`  ✗ ${e.to} → ${r.status} ${r.body}`);
    }
    // 15-second pacing per send to match sender.js cadence
    await new Promise(r => setTimeout(r, 15000));
  }
  console.log(`\nDone. Sent ${sent}, failed ${failed}.`);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
