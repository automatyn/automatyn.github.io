#!/usr/bin/env node
// Reply-watcher: polls @patrickssons profile via fxtwitter, detects when
// reply_count on one of his latest tweets goes UP, pings Telegram with a
// one-tap link to engage the new reply. Reply-back = 150x impressions per
// reference_x_algorithm.md.
//
// Strategy: fxtwitter doesn't expose mention search, but it DOES expose
// reply_count per tweet on the profile feed. Delta-detection between runs
// catches new replies without needing paid X API.
//
// Usage: node reply-watcher.js  (run from systemd timer every 10 min)

const fs = require('fs');
const path = require('path');
const https = require('https');

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';
const HANDLE = 'patrickssons';
const STATE_FILE = path.join(__dirname, 'reply-watcher-state.json');

function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; reply-watcher/1.0)' },
      timeout: 10000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null)).on('timeout', function () { this.destroy(); resolve(null); });
  });
}

function tg(msg) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TG_CHAT, text: msg, disable_web_page_preview: false });
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
    req.on('error', () => resolve({ ok: false }));
    req.write(body); req.end();
  });
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function run() {
  const data = await get(`https://api.fxtwitter.com/2/profile/${HANDLE}/statuses`);
  if (!data || !Array.isArray(data.results)) {
    console.error('No data from fxtwitter');
    process.exit(1);
  }

  const state = loadState();
  const prev = state.tweets || {};
  const now = {};
  const newReplies = [];

  // Only watch tweets <24h old
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const t of data.results) {
    if (!t.id) continue;
    const created = t.created_timestamp ? t.created_timestamp * 1000 : Date.parse(t.created_at);
    if (!created || created < cutoff) continue;
    now[t.id] = {
      replies: t.replies || 0,
      likes: t.likes || 0,
      reposts: t.reposts || 0,
      text: (t.text || '').slice(0, 200),
      url: t.url || `https://x.com/${HANDLE}/status/${t.id}`,
      created: t.created_at,
    };
    const prevReplies = prev[t.id]?.replies || 0;
    const delta = (t.replies || 0) - prevReplies;
    if (delta > 0 && Object.keys(prev).length > 0) {
      newReplies.push({ id: t.id, delta, ...now[t.id] });
    }
  }

  // Save current state for next run
  saveState({ tweets: now, last_run: new Date().toISOString() });

  if (newReplies.length === 0) {
    console.log(`No new replies. Watching ${Object.keys(now).length} tweets.`);
    return;
  }

  // Push to Telegram
  for (const t of newReplies) {
    const msg = `NEW REPLIES on your tweet (+${t.delta}, now ${t.replies} total)\n\nYOUR TWEET:\n${t.text}\n\nGO REPLY-BACK FAST (algo 150x window):\n${t.url}`;
    await tg(msg);
    console.log(`Pinged: tweet ${t.id} (+${t.delta} replies)`);
  }
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
