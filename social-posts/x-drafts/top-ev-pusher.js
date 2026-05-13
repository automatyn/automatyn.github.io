#!/usr/bin/env node
// Top-EV pusher: reads firehose-candidates.json, scores each by leverage
// (author_followers * engagement * recency), pushes the top N to Telegram
// as URGENT prompts — Pat hand-writes reply on phone.
//
// Reasoning: draft-from-candidates.js has reply emission disabled because the
// angle library was bot-tier. Top-EV targets warrant human-crafted replies.
// This surfaces those rather than letting them sit in a 135-item JSON.
//
// Usage: node top-ev-pusher.js [N=3]  (run from systemd timer every 30 min,
// just after firehose-fxt fires)

const fs = require('fs');
const path = require('path');
const https = require('https');

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';
const N = parseInt(process.argv[2] || '3', 10);
const CAND_FILE = path.join(__dirname, 'firehose-candidates.json');
const SEEN_FILE = path.join(__dirname, 'top-ev-seen.json');

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

function loadSeen() {
  if (!fs.existsSync(SEEN_FILE)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveSeen(s) {
  // Keep only most recent 500
  const arr = Array.from(s).slice(-500);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(arr));
}

function isUnrepliable(text) {
  if (!text || text.length < 40) return true;
  // Politics / personal / promo
  if (/\b(mother.s day|mothers day|father.s day|happy birthday|RIP|condolences|election|democrat|republican|trump|biden|gaza|ukraine|charity)\b/i.test(text)) return true;
  // Pure self-promo / link-only
  const before = text.split(/https?:\/\//)[0].trim().split(/\s+/).length;
  if (before < 8 && /https?:\/\//.test(text)) return true;
  // Personal life dialogue
  if (/^(Liam:|Me:|Dad:|Mom:|Mum:|Son:|Daughter:|Wife:|Husband:)/m.test(text)) return true;
  return false;
}

function score(c) {
  const f = c.author_followers || 0;
  const e = (c.likes || 0) + (c.replies || 0) * 2 + (c.reposts || 0) * 3;
  const ageH = c.age_hours || 6;
  const recency = Math.max(0.1, 6 - ageH) / 6;   // 1.0 at 0h, 0.1 at 6h+
  const followerWeight = Math.log10(Math.max(f, 100)) / 7;  // ~0.7 at 1k, ~1.0 at 10M
  const engWeight = Math.log10(Math.max(e, 1) + 1) / 4;
  return f * (1 + engWeight * 3) * recency * followerWeight;
}

async function run() {
  if (!fs.existsSync(CAND_FILE)) { console.error('No firehose-candidates.json'); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(CAND_FILE, 'utf8'));
  const cands = data.candidates || [];
  console.log(`Read ${cands.length} candidates`);

  const seen = loadSeen();
  const fresh = cands.filter(c =>
    c.tweet_id &&
    !seen.has(String(c.tweet_id)) &&
    !isUnrepliable(c.text) &&
    (c.age_hours || 0) <= 4   // must be <4h old for algo recency
  );

  fresh.forEach(c => c._score = score(c));
  fresh.sort((a, b) => b._score - a._score);
  const top = fresh.slice(0, N);

  if (top.length === 0) {
    console.log('No fresh top-EV candidates this cycle');
    return;
  }

  for (let i = 0; i < top.length; i++) {
    const c = top[i];
    const url = `https://x.com/${c.handle}/status/${c.tweet_id}`;
    const msg = `URGENT HIGH-EV TARGET (rank ${i + 1}/${top.length})\n` +
                `@${c.handle} | ${(c.author_followers || 0).toLocaleString()}f | ${c.age_hours}h old | ${c.likes || 0}l ${c.replies || 0}r ${c.reposts || 0}rt\n\n` +
                `TWEET:\n${(c.text || '').slice(0, 300)}\n\n` +
                `WRITE YOUR OWN REPLY (no template — quality + reply-back is the win):\n${url}`;
    const r = await tg(msg);
    if (r.ok) seen.add(String(c.tweet_id));
    console.log(`${i + 1}: @${c.handle} ${c.author_followers} f, score=${Math.round(c._score)}`);
    await new Promise(r => setTimeout(r, 400));
  }

  saveSeen(seen);
  console.log(`Pushed top ${top.length} EV targets`);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
