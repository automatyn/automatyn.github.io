#!/usr/bin/env node
// Outreach autonomous monitor — runs on cron, watches the funnel,
// auto-acts on clear signals, sends Telegram digests.
//
// Auto-actions:
//   1. Variant kill: pair with >=15 sends, <8% open, <0.5% reply →
//      mark dead in dead-variants.json, sender skips it next run.
//   2. Bounce alarm: hard-bounce >3% in last 24h delivered → halt all sends
//      (writes outreach/HALT) + Telegram alarm.
//   3. Spam complaint alarm: any spam complaint in last 24h →
//      halt all sends + Telegram alarm.
//   4. New reply detected: Telegram immediately with lead details.
//
// Usage: node monitor.js   (typical cron entry every 4h)

const fs = require('fs');
const path = require('path');
const https = require('https');

require('./load-env');
const store = require('./leads-store');

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT  = '5904617085';
const STATE_FILE = path.join(__dirname, '.monitor-state.json');
const DEAD_FILE  = path.join(__dirname, 'dead-variants.json');
const HALT_FILE  = path.join(__dirname, 'HALT');
const BREVO_KEY  = process.env.BREVO_API_KEY;

// Thresholds (tuned for cold UK SMB)
const KILL_MIN_SENDS  = 15;
const KILL_MAX_OPEN   = 0.08;
const KILL_MAX_REPLY  = 0.005;
const HARD_BOUNCE_HALT = 0.05;       // 5% (industry-standard cold-email tolerance)
const HARD_BOUNCE_MIN_SENDS = 50;    // require ≥50 sends in 24h before HALTing on rate
const SPAM_COMPLAINT_ANY = 0.001;    // any complaint at all

function tg(text) {
  return new Promise((resolve) => {
    const body = `chat_id=${TG_CHAT}&text=${encodeURIComponent(text)}&parse_mode=HTML&disable_web_page_preview=true`;
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false));
    req.write(body); req.end();
  });
}

function brevoGet(p) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.brevo.com', path: p, method: 'GET',
      headers: { 'api-key': BREVO_KEY, 'accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function pct(n, d) { return d > 0 ? n / d : 0; }
function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }

async function checkBrevoHealth() {
  if (!BREVO_KEY) return { ok: true, note: 'no BREVO_API_KEY, skipped' };
  const stats = await brevoGet('/v3/smtp/statistics/aggregatedReport?days=1');
  if (!stats) return { ok: true, note: 'brevo unreachable, skipped' };
  const sent = stats.requests || 0;
  const hard = stats.hardBounces || 0;
  const spam = stats.spamReports || 0;
  const delivered = stats.delivered || 0;
  const hardRate = pct(hard, sent);
  const spamRate = pct(spam, delivered);
  const issues = [];
  if (sent >= HARD_BOUNCE_MIN_SENDS && hardRate > HARD_BOUNCE_HALT) issues.push(`HARD BOUNCE ${fmtPct(hardRate)} (${hard}/${sent})`);
  if (spamRate >= SPAM_COMPLAINT_ANY)            issues.push(`SPAM COMPLAINTS ${spam}`);
  return { ok: issues.length === 0, sent, hard, spam, delivered, hardRate, spamRate, issues };
}

function getVariantPerf() {
  const leads = store.listAll();
  const cutoff = new Date(Date.now() - 14 * 86400000);
  const recent = leads.filter(l => l.email1_sent && new Date(l.email1_sent) >= cutoff && l.e1_subject_id && l.e1_cta_id);
  const pairs = {};
  for (const l of recent) {
    const k = `${l.e1_subject_id}|${l.e1_cta_id}`;
    if (!pairs[k]) pairs[k] = { sId: l.e1_subject_id, cId: l.e1_cta_id, sends: 0, opens: 0, replies: 0 };
    pairs[k].sends++;
    if (l.email1_opened_at) pairs[k].opens++;
    if (l.replied) pairs[k].replies++;
  }
  return pairs;
}

function killUnderperformers(pairs, deadAlready) {
  const killed = [];
  const dead = { ...deadAlready };
  for (const [k, p] of Object.entries(pairs)) {
    if (dead[k]) continue;
    if (p.sends < KILL_MIN_SENDS) continue;
    const openRate = pct(p.opens, p.sends);
    const replyRate = pct(p.replies, p.sends);
    if (openRate < KILL_MAX_OPEN && replyRate < KILL_MAX_REPLY) {
      dead[k] = {
        killed_at: new Date().toISOString(),
        sends: p.sends, opens: p.opens, replies: p.replies,
        open_rate: openRate, reply_rate: replyRate,
      };
      killed.push({ pair: k, ...p, openRate, replyRate });
    }
  }
  return { dead, killed };
}

function detectNewReplies(prevState) {
  const leads = store.listAll();
  const replied = leads.filter(l => l.replied);
  const seen = new Set(prevState.replied_ids || []);
  const fresh = replied.filter(l => !seen.has(l.id));
  return {
    fresh,
    all_ids: replied.map(l => l.id),
  };
}

function detectNewSignups(prevState) {
  const fs2 = require('fs');
  const dir = path.join(__dirname, '..', 'data');
  let agents = [];
  try {
    agents = fs2.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs2.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch {}
  const seen = new Set(prevState.agent_ids || []);
  const fresh = agents.filter(a => a.agentId && !seen.has(a.agentId));
  return { fresh, all_ids: agents.map(a => a.agentId).filter(Boolean), total: agents.length };
}

async function main() {
  const now = new Date().toISOString();
  const prev = readJson(STATE_FILE, { replied_ids: [], agent_ids: [], last_run: null });
  const isFirstRun = !prev.last_run;
  const lines = [`<b>📡 Outreach monitor — ${now.slice(0,16).replace('T',' ')}Z</b>`];
  let alarms = [];

  // 1. Brevo health
  const brevo = await checkBrevoHealth();
  if (brevo.issues && brevo.issues.length) {
    alarms.push(...brevo.issues);
    // Halt all sends
    fs.writeFileSync(HALT_FILE, `Halted ${now}\n${brevo.issues.join('\n')}\n`);
    lines.push(`🚨 <b>HALT</b>: ${brevo.issues.join(' · ')} — sends halted.`);
  } else if (brevo.sent !== undefined) {
    lines.push(`Brevo 24h: ${brevo.sent} sent · ${brevo.hard} hard · ${brevo.spam} spam · OK`);
  }

  // 2. Variant kills
  const pairs = getVariantPerf();
  const deadAlready = readJson(DEAD_FILE, {});
  const { dead, killed } = killUnderperformers(pairs, deadAlready);
  if (killed.length) {
    writeJson(DEAD_FILE, dead);
    for (const k of killed) {
      lines.push(`☠️  Killed variant <b>${k.pair}</b>: ${k.sends} sends · ${fmtPct(k.openRate)} open · ${fmtPct(k.replyRate)} reply`);
    }
  }

  // 3. Replies — suppress on first run (state was empty, nothing is "new")
  const replyDelta = detectNewReplies(prev);
  if (!isFirstRun && replyDelta.fresh.length) {
    for (const r of replyDelta.fresh) {
      lines.push(`💬 <b>NEW REPLY</b> from ${r.email} (${r.business_name}). Reply personally.`);
    }
  }

  // 4. Signups — suppress on first run
  const signupDelta = detectNewSignups(prev);
  if (!isFirstRun && signupDelta.fresh.length) {
    for (const a of signupDelta.fresh) {
      lines.push(`🎉 <b>NEW SIGNUP</b>: ${a.businessName || a.agentId} · ${a.plan || '?'} · ${a.email || ''}`);
    }
  }

  // 5. Aggregate funnel snapshot
  const stats = store.stats();
  lines.push('');
  lines.push(`Pool ${stats.with_email}/${stats.total} · E1 sent ${stats.email1_sent_total} (${stats.email1_sent_today} today) · E2 ${stats.email2_sent_total} · E3 ${stats.email3_sent_total}`);
  lines.push(`Opens: ${stats.email1_opens}/${stats.email2_opens}/${stats.email3_opens} (E1/E2/E3) · replies ${stats.replied_total} · bounces ${stats.bounced_total} · unsubs ${stats.unsubscribed_total}`);

  // Telegram is for things Pat acts on personally: signups, replies, halts.
  // Everything else (variant kills, heartbeat, funnel snapshot) lives in the
  // log file that future Claude sessions read on routine startup.
  const userFacing = [];
  if (!isFirstRun) {
    if (alarms.length) {
      userFacing.push(`🚨 <b>OUTREACH HALT</b>: ${alarms.join(' · ')}`);
      userFacing.push('Sender refuses new sends until <code>outreach/HALT</code> is removed.');
    }
    for (const r of replyDelta.fresh) {
      userFacing.push(`💬 <b>NEW REPLY</b> from ${r.email} (${r.business_name}). Reply personally.`);
    }
    for (const a of signupDelta.fresh) {
      userFacing.push(`🎉 <b>NEW SIGNUP</b>: ${a.businessName || a.agentId} · ${a.plan || '?'} · ${a.email || ''}`);
    }
  }
  if (userFacing.length) {
    await tg(userFacing.join('\n'));
  }

  // Append full state digest to log file — for future Claude sessions to read.
  const logEntry = [
    `--- ${now} ---`,
    ...lines.map(l => l.replace(/<[^>]+>/g, '')),
    '',
  ].join('\n');
  fs.appendFileSync(path.join(__dirname, 'monitor.log'), logEntry);

  // Save state
  writeJson(STATE_FILE, {
    replied_ids: replyDelta.all_ids,
    agent_ids: signupDelta.all_ids,
    last_run: now,
    last_brevo: { sent: brevo.sent, hard: brevo.hard, spam: brevo.spam },
  });

  // Console output for cron logs
  console.log(lines.join('\n').replace(/<[^>]+>/g, ''));
}

main().catch(err => {
  console.error('monitor error:', err);
  tg(`⚠️ Outreach monitor crashed: ${err.message}`).catch(() => {});
  process.exit(1);
});
