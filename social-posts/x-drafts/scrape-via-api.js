#!/usr/bin/env node
// Scrapes recent posts from target-list.json via X API v2 (read-only, Bearer Token).
// Replaces scrape-targets.js (browser-use). Cheaper, faster, no anti-scrape wall.
//
// Cost model: $0.005 per post returned. Hard monthly cap of 900 reads ($4.50).
// Per-slot default: 10 reads. Override with arg.
//
// Usage: node scrape-via-api.js [maxReads] [hoursWindow]
//        defaults: 10 reads, 24h window

const fs = require('fs');
const path = require('path');
const https = require('https');

const dir = __dirname;
const targets = JSON.parse(fs.readFileSync(path.join(dir, 'target-list.json'), 'utf8'));

const MAX_READS = parseInt(process.argv[2] || '10', 10);
const HOURS = parseInt(process.argv[3] || '24', 10);

const BUDGET_FILE = path.join(__dirname, '..', 'x-api-budget.json');
const MONTHLY_CAP_READS = 900; // $4.50 / $0.005

const BEARER = process.env.X_BEARER_TOKEN;
if (!BEARER) {
  console.error('X_BEARER_TOKEN env var missing. Aborting.');
  process.exit(1);
}

function loadBudget() {
  try {
    const b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    if (b.month !== ym) return { month: ym, reads: 0, writes: 0 };
    return b;
  } catch {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    return { month: ym, reads: 0, writes: 0 };
  }
}

function saveBudget(b) {
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(b, null, 2));
}

function apiGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.x.com',
      path: pathAndQuery,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${BEARER}` }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const handles = [];
const seen = new Set();
for (const group of Object.values(targets.groups)) for (const h of group) {
  if (!seen.has(h)) { seen.add(h); handles.push(h); }
}

const skipPatterns = [
  /^gm\b/i, /^gn\b/i, /\bgiveaway\b/i,
  /\b(crypto|airdrop|presale|memecoin)\b/i,
  /\b(dm me|telegram\.me)\b/i
];
function shouldSkip(text) {
  if (!text || text.length < 40) return true;
  for (const p of skipPatterns) if (p.test(text)) return true;
  return false;
}

(async () => {
  const budget = loadBudget();
  const remaining = MONTHLY_CAP_READS - budget.reads;
  if (remaining <= 0) {
    console.error(`Monthly read cap hit (${budget.reads}/${MONTHLY_CAP_READS}). Aborting.`);
    process.exit(2);
  }
  const reads = Math.min(MAX_READS, remaining);
  console.log(`Budget: ${budget.reads}/${MONTHLY_CAP_READS} reads used this month. Pulling ${reads}.`);

  // Chunk handles so each query stays under 480 chars (X Basic tier limit is 512).
  const chunks = [];
  let cur = [];
  let curLen = 30;
  for (const h of handles) {
    const add = `from:${h} OR `.length;
    if (curLen + add > 470 && cur.length > 0) { chunks.push(cur); cur = []; curLen = 30; }
    cur.push(h);
    curLen += add;
  }
  if (cur.length > 0) chunks.push(cur);

  const cutoff = new Date(Date.now() - HOURS * 3600 * 1000).toISOString();
  const startTime = encodeURIComponent(cutoff);
  const fields = 'created_at,public_metrics,author_id';
  const expansions = 'author_id';
  const userFields = 'username,public_metrics';
  const perChunkMax = Math.max(10, Math.ceil(reads / chunks.length)); // X requires min 10

  const tweets = [];
  const users = {};
  for (const ch of chunks) {
    const fromQuery = ch.map(h => `from:${h}`).join(' OR ');
    const query = encodeURIComponent(`(${fromQuery}) -is:retweet -is:reply lang:en`);
    const url = `/2/tweets/search/recent?query=${query}&max_results=${perChunkMax}&start_time=${startTime}&tweet.fields=${fields}&expansions=${expansions}&user.fields=${userFields}`;
    let resp;
    try {
      resp = await apiGet(url);
    } catch (e) {
      console.error('API chunk failed:', e.message);
      continue;
    }
    for (const t of (resp.data || [])) tweets.push(t);
    for (const u of (resp.includes?.users || [])) users[u.id] = u;
  }
  // Truncate to requested read count (we may have pulled more across chunks)
  tweets.splice(reads);

  // Each post returned costs $0.005
  budget.reads += tweets.length;
  saveBudget(budget);

  const candidates = [];
  let kept = 0, skippedContent = 0;
  for (const t of tweets) {
    if (shouldSkip(t.text)) { skippedContent++; continue; }
    const u = users[t.author_id];
    const handle = u?.username || 'unknown';
    const followers = u?.public_metrics?.followers_count || 0;
    const ageMs = Date.now() - new Date(t.created_at).getTime();
    candidates.push({
      handle,
      tweet_id: t.id,
      url: `https://x.com/${handle}/status/${t.id}`,
      text: t.text.slice(0, 280),
      created_at: t.created_at,
      age_hours: Math.round(ageMs / 360000) / 10,
      likes: t.public_metrics?.like_count || 0,
      replies: t.public_metrics?.reply_count || 0,
      reposts: t.public_metrics?.retweet_count || 0,
      views: t.public_metrics?.impression_count || 0,
      author_followers: followers
    });
    kept++;
  }

  candidates.sort((a, b) => {
    const sa = a.likes + a.replies * 2 + a.reposts * 3;
    const sb = b.likes + b.replies * 2 + b.reposts * 3;
    return sb - sa;
  });

  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({
    scraped_at: new Date().toISOString(),
    window_hours: HOURS,
    source: 'x-api-v2',
    stats: { reads_charged: tweets.length, kept, skippedContent },
    budget: { used: budget.reads, cap: MONTHLY_CAP_READS, remaining: MONTHLY_CAP_READS - budget.reads },
    candidates
  }, null, 2));

  console.log(`reads=${tweets.length} kept=${kept} skipContent=${skippedContent}`);
  console.log(`budget: ${budget.reads}/${MONTHLY_CAP_READS} used ($${(budget.reads * 0.005).toFixed(2)} of $4.50)`);
  console.log(`wrote candidates.json (${candidates.length} candidates)`);
})();
