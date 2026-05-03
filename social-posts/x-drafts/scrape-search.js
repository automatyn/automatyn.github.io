#!/usr/bin/env node
// Scrapes X live search timelines via logged-in Chrome at CDP 18800.
// Visits multiple search URLs, extracts ~30 articles each. No profile-hammering.
// Usage: node scrape-search.js [hoursWindow]   (default 6)

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const dir = __dirname;
const hoursWindow = parseInt(process.argv[2] || '6', 10);
const CDP = 'http://localhost:18800';

// Search queries — broad SMB + AI + trades + follow-up territory.
// Each is hit once. Live tab returns most recent posts.
const queries = [
  '"small business" struggling',
  '"small business" overwhelmed',
  '"follow up" leads',
  '"missed calls" business',
  '"AI agent" small business',
  '"chatbot" small business',
  'plumber admin',
  'electrician paperwork',
  '"build in public" founder',
  '"small business owner" tired',
  '"booking" appointment missed',
  '"customer service" slow',
  '"automation" small business',
  '"receptionist" cost',
  'tradesman phone',
  '"side project" launched'
];

const skipPatterns = [
  /^gm\b/i, /^gn\b/i, /\bgiveaway\b/i,
  /\b(crypto|airdrop|presale|memecoin|NFT|token launch)\b/i,
  /\b(dm me|telegram\.me|t\.me\/)\b/i,
  /\b(onlyfans|nude|sex)\b/i,
  /^\$[A-Z]{2,5}\b/
];

function shouldSkip(text) {
  if (!text) return true;
  if (text.length < 50) return true;
  if (text.length > 500) return true;
  for (const p of skipPatterns) if (p.test(text)) return true;
  return false;
}

const EVAL_JS = `JSON.stringify(Array.from(document.querySelectorAll('article')).slice(0,40).map(a=>{const u=a.querySelector('a[href*="/status/"]')?.href;const id=u?(u.match(/status\\/(\\d+)/)||[])[1]:null;const ts=a.querySelector('time')?.getAttribute('datetime');const tx=a.querySelector('[data-testid="tweetText"]')?.innerText||'';const txt=a.innerText||'';const aria=a.querySelector('[role="group"]')?.getAttribute('aria-label')||'';return {id,ts,tx:tx.slice(0,400),txt:txt.slice(0,200),aria,url:u}}).filter(x=>x.id&&x.tx))`;

function pyToJson(s) {
  return s
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/'/g, '"')
    .replace(/\\\\/g, '\\');
}

function bu(args) {
  const r = spawnSync('browser-use', ['--cdp-url', CDP, ...args], {
    encoding: 'utf8', timeout: 35000
  });
  return (r.stdout || '') + (r.stderr || '');
}

(async () => {
  const seen = new Set();
  const candidates = [];
  let totalRaw = 0, kept = 0, skipAge = 0, skipContent = 0, skipReply = 0, skipDupe = 0, errors = 0;
  const cutoff = Date.now() - hoursWindow * 3600 * 1000;
  const perQuery = {};

  console.log(`Scraping ${queries.length} search queries, last ${hoursWindow}h...`);

  // Reset any stale browser-use session config from a previous run.
  spawnSync('browser-use', ['close'], { encoding: 'utf8', timeout: 10000 });

  for (const q of queries) {
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=live`;
    try {
      bu(['open', url]);
      execSync('sleep 5');
      // Scroll once for more results.
      bu(['scroll', 'down']);
      execSync('sleep 3');
      bu(['scroll', 'down']);
      execSync('sleep 2');
      const out = bu(['eval', EVAL_JS]);
      if (process.env.DEBUG_SCRAPE) console.error(`[${q}] OUT:`, out.slice(0, 500));
      const idx = out.indexOf('result:');
      if (idx === -1) { errors++; perQuery[q] = 'no-result'; process.stdout.write('x'); execSync('sleep 5'); continue; }
      const raw = out.slice(idx + 7).trim();
      let posts;
      try { posts = JSON.parse(raw); } catch (e) { errors++; perQuery[q] = 'parse-fail'; process.stdout.write('x'); execSync('sleep 5'); continue; }
      let qKept = 0;
      totalRaw += posts.length;
      for (const p of posts) {
        if (!p.ts) continue;
        const ageMs = Date.now() - new Date(p.ts).getTime();
        if (ageMs > hoursWindow * 3600 * 1000) { skipAge++; continue; }
        const handleMatch = (p.url || '').match(/x\.com\/([^/]+)\/status/);
        const handle = handleMatch ? handleMatch[1] : null;
        if (!handle) { skipContent++; continue; }
        const txt = p.txt || '';
        const isRep = /^Replying to /m.test(txt);
        const isRT = (txt.split('\n')[0] || '').includes('reposted');
        if (isRep || isRT) { skipReply++; continue; }
        if (shouldSkip(p.tx)) { skipContent++; continue; }
        if (seen.has(p.id)) { skipDupe++; continue; }
        seen.add(p.id);
        const aria = p.aria || '';
        const num = (re) => { const m = aria.match(re); return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0; };
        candidates.push({
          handle,
          tweet_id: p.id,
          url: p.url,
          text: p.tx,
          created_at: p.ts,
          age_hours: Math.round(ageMs / 360000) / 10,
          likes: num(/([\d,]+)\s+like/i),
          replies: num(/([\d,]+)\s+repl/i),
          reposts: num(/([\d,]+)\s+repost/i),
          views: num(/([\d,]+)\s+view/i),
          query: q
        });
        kept++; qKept++;
      }
      perQuery[q] = `ok(${qKept}/${posts.length})`;
      process.stdout.write('.');
      execSync('sleep 6');
    } catch (e) {
      errors++; perQuery[q] = 'exception';
      process.stdout.write('x');
      execSync('sleep 5');
    }
  }
  console.log();

  // Rank by engagement-per-hour (fresh + engaging beats old + viral).
  candidates.sort((a, b) => {
    const sa = (a.likes + a.replies * 2 + a.reposts * 3) / Math.max(a.age_hours, 0.1);
    const sb = (b.likes + b.replies * 2 + b.reposts * 3) / Math.max(b.age_hours, 0.1);
    return sb - sa;
  });

  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({
    scraped_at: new Date().toISOString(),
    window_hours: hoursWindow,
    source: 'live-search',
    stats: { queries: queries.length, totalRaw, kept, skipAge, skipReply, skipContent, skipDupe, errors },
    perQuery,
    candidates
  }, null, 2));
  console.log(`queries=${queries.length} raw=${totalRaw} kept=${kept} skipAge=${skipAge} skipReply=${skipReply} skipContent=${skipContent} skipDupe=${skipDupe} err=${errors}`);
  console.log(`wrote candidates.json (${candidates.length} candidates)`);
})();
