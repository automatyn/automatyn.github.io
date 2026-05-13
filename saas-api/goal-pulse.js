#!/usr/bin/env node
// Daily goal pulse. Reads Paddle, leads-store, fxtwitter, service health.
// Posts a one-message digest to Telegram. Urgent ping on alert conditions.
//
// Usage: PADDLE_API_KEY=... node goal-pulse.js
// Run via systemd timer at 09:00 UTC daily.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';
const PADDLE_API_KEY = process.env.PADDLE_API_KEY;
const LEADS_FILE = '/home/marketingpatpat/openclaw/saas-api/outreach/data/leads.json';
const FIREHOSE_FILE = '/home/marketingpatpat/openclaw/social-posts/x-drafts/firehose-candidates.json';
const MONITOR_LOG = '/home/marketingpatpat/openclaw/saas-api/outreach/monitor.log';
const HALT_FILE = '/home/marketingpatpat/openclaw/saas-api/outreach/HALT';
const STATE_FILE = '/home/marketingpatpat/openclaw/saas-api/goal-pulse-state.json';

function get(url, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const h = { 'User-Agent': 'Mozilla/5.0 (compatible; automatyn-goal-pulse/1.0)', ...headers };
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: h, timeout: 10000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

function tg(msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TG_CHAT, text: msg, disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200 }));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function paddleState() {
  if (!PADDLE_API_KEY) return { error: 'PADDLE_API_KEY not set' };
  const completed = await get('https://api.paddle.com/transactions?status=completed&per_page=10', { Authorization: `Bearer ${PADDLE_API_KEY}` });
  const billed = await get('https://api.paddle.com/transactions?status=billed&per_page=10', { Authorization: `Bearer ${PADDLE_API_KEY}` });
  const subs = await get('https://api.paddle.com/subscriptions?status=active&per_page=10', { Authorization: `Bearer ${PADDLE_API_KEY}` });
  const draft = await get('https://api.paddle.com/transactions?status=draft&per_page=50', { Authorization: `Bearer ${PADDLE_API_KEY}` });
  return {
    completed: completed?.data?.length || 0,
    billed: billed?.data?.length || 0,
    active_subs: subs?.data?.length || 0,
    draft: draft?.data?.length || 0,
    latest_completed: completed?.data?.[0]?.created_at?.slice(0, 10) || null,
  };
}

function outreachState() {
  if (!fs.existsSync(LEADS_FILE)) return { error: 'no leads file' };
  const leads = Object.values(JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')));
  const today = new Date().toISOString().slice(0, 10);
  const e1_today = leads.filter(l => l.email1_sent?.startsWith(today)).length;
  const e2_today = leads.filter(l => l.email2_sent?.startsWith(today)).length;
  const e3_today = leads.filter(l => l.email3_sent?.startsWith(today)).length;
  const e1_lifetime = leads.filter(l => l.email1_sent).length;
  const replied = leads.filter(l => l.replied).length;
  const bounced = leads.filter(l => l.bounced).length;
  const dns = leads.filter(l => l.do_not_send).length;
  const pool_with_email = leads.filter(l => l.email && !l.do_not_send && !l.bounced).length;
  const halt = fs.existsSync(HALT_FILE);
  return { e1_today, e2_today, e3_today, e1_lifetime, replied, bounced, dns, pool_with_email, halt, total: leads.length };
}

async function xState() {
  const r = await get('https://api.fxtwitter.com/patrickssons');
  if (!r || !r.user) return { error: 'fxtwitter no data' };
  return {
    followers: r.user.followers,
    tweets: r.user.tweets,
    verified: r.user.verification?.verified || false,
  };
}

function firehoseState() {
  if (!fs.existsSync(FIREHOSE_FILE)) return { error: 'no firehose file' };
  const stat = fs.statSync(FIREHOSE_FILE);
  const ageMin = Math.round((Date.now() - stat.mtimeMs) / 60000);
  const data = JSON.parse(fs.readFileSync(FIREHOSE_FILE, 'utf8'));
  return { last_run_min: ageMin, candidates: data.candidates?.length || 0 };
}

function serviceState() {
  const services = ['openclaw-gateway', 'automatyn-api', 'x-firehose.timer', 'x-gate-poller', 'seo-daily.timer'];
  const out = {};
  for (const s of services) {
    try {
      out[s] = execSync(`systemctl is-active ${s}`, { encoding: 'utf8' }).trim();
    } catch (e) {
      out[s] = e.stdout?.trim() || 'unknown';
    }
  }
  return out;
}

async function main() {
  const state = loadState();
  const today = new Date().toISOString().slice(0, 10);

  const [paddle, x] = await Promise.all([paddleState(), xState()]);
  const outreach = outreachState();
  const firehose = firehoseState();
  const services = serviceState();

  const alerts = [];
  // First Paddle txn ever
  if (paddle.completed > (state.last_paddle_completed || 0)) {
    alerts.push(`PADDLE TXN LANDED. completed=${paddle.completed}. Goal: first sale.`);
  }
  if (paddle.billed > 0) alerts.push(`PADDLE billed=${paddle.billed} (subscription likely active)`);
  if (paddle.active_subs > 0) alerts.push(`PADDLE active subscriptions: ${paddle.active_subs}`);
  // HALT
  if (outreach.halt) alerts.push('OUTREACH HALT FILE PRESENT. Sender blocked.');
  // Service down
  for (const [s, v] of Object.entries(services)) {
    if (v !== 'active') alerts.push(`SERVICE ${s}: ${v}`);
  }
  // X account check
  if (x.error) alerts.push(`X account unreachable: ${x.error}`);
  // Firehose stale (>2h)
  if (firehose.last_run_min > 120) alerts.push(`X firehose stale: last run ${firehose.last_run_min}min ago`);

  // Deltas vs yesterday
  const dFollowers = state.last_followers ? x.followers - state.last_followers : null;
  const dE1 = state.last_e1_lifetime ? outreach.e1_lifetime - state.last_e1_lifetime : null;
  const dReplied = state.last_replied ? outreach.replied - state.last_replied : null;

  const lines = [
    `PULSE ${today} 09:00 UTC`,
    ``,
    `SALES (Paddle):`,
    `  completed: ${paddle.completed}  billed: ${paddle.billed}  active subs: ${paddle.active_subs}  draft: ${paddle.draft}`,
    `  latest completed: ${paddle.latest_completed || 'none ever'}`,
    ``,
    `OUTREACH:`,
    `  today E1=${outreach.e1_today} E2=${outreach.e2_today} E3=${outreach.e3_today}`,
    `  lifetime E1=${outreach.e1_lifetime}${dE1 !== null ? ` (${dE1 >= 0 ? '+' : ''}${dE1})` : ''}  replied=${outreach.replied}${dReplied !== null ? ` (${dReplied >= 0 ? '+' : ''}${dReplied})` : ''}`,
    `  pool_with_email=${outreach.pool_with_email}  DNS=${outreach.dns}  bounced=${outreach.bounced}`,
    `  HALT: ${outreach.halt ? 'YES — blocked' : 'no'}`,
    ``,
    `X (@patrickssons):`,
    `  followers=${x.followers}${dFollowers !== null ? ` (${dFollowers >= 0 ? '+' : ''}${dFollowers})` : ''}  tweets=${x.tweets}  premium=${x.verified ? 'yes' : 'NO'}`,
    `  firehose last run: ${firehose.last_run_min}min ago, ${firehose.candidates} candidates`,
    ``,
    `HEALTH:`,
    `  ${Object.entries(services).map(([s, v]) => `${s}=${v}`).join('  ')}`,
  ];

  if (alerts.length > 0) {
    lines.unshift(`!!! ALERTS !!!`);
    alerts.forEach(a => lines.push(`  ! ${a}`));
  }

  const msg = lines.join('\n');
  console.log(msg);

  // Always send to Telegram
  await tg(msg);

  // Save state for next-day deltas
  saveState({
    last_run: new Date().toISOString(),
    last_paddle_completed: paddle.completed,
    last_paddle_billed: paddle.billed,
    last_paddle_subs: paddle.active_subs,
    last_followers: x.followers,
    last_tweets: x.tweets,
    last_e1_lifetime: outreach.e1_lifetime,
    last_replied: outreach.replied,
    last_bounced: outreach.bounced,
  });
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
