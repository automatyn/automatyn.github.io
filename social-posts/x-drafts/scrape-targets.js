#!/usr/bin/env node
// Scrapes last-N-hour posts from target-list.json via the logged-in Chrome at CDP 18800.
// Visits each profile, runs an extraction JS via browser-use eval, parses Python-dict output.
// Usage: node scrape-targets.js [hours] [maxPerHandle]   (default 24, 5)

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const dir = __dirname;
const targets = JSON.parse(fs.readFileSync(path.join(dir, 'target-list.json'), 'utf8'));
const hoursWindow = parseInt(process.argv[2] || '24', 10);
const maxPerHandle = parseInt(process.argv[3] || '5', 10);
const CDP = 'http://localhost:18800';

const handles = [];
const seen = new Set();
for (const group of Object.values(targets.groups)) for (const h of group) {
  if (!seen.has(h)) { seen.add(h); handles.push(h); }
}

console.log(`Scraping ${handles.length} handles, last ${hoursWindow}h, up to ${maxPerHandle} posts each...`);

const skipPatterns = [
  /^gm\b/i, /^gn\b/i, /\bgiveaway\b/i,
  /\b(crypto|airdrop|presale|memecoin)\b/i,
  /\b(dm me|telegram\.me)\b/i
];

function shouldSkip(text) {
  if (!text) return true;
  if (text.length < 40) return true;
  for (const p of skipPatterns) if (p.test(text)) return true;
  return false;
}

// Single-line JS expression for browser-use eval
const EVAL_JS = `Array.from(document.querySelectorAll('article')).slice(0,8).map(a=>{const u=a.querySelector('a[href*="/status/"]')?.href;const id=u?(u.match(/status\\/(\\d+)/)||[])[1]:null;const ts=a.querySelector('time')?.getAttribute('datetime');const tx=a.querySelector('[data-testid="tweetText"]')?.innerText||'';const isRep=/^Replying to /m.test(a.innerText);const isRT=a.innerText.split('\\n')[0].includes('reposted');const aria=a.querySelector('[role="group"]')?.getAttribute('aria-label')||'';return {id,ts,tx:tx.slice(0,280),isRep,isRT,aria,url:u}}).filter(x=>x.id&&x.tx)`;

function pyToJson(s) {
  // Convert Python-style dict output (single quotes, True/False/None) to JSON
  return s
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/\bNone\b/g, 'null')
    .replace(/'/g, '"')
    .replace(/\\\\/g, '\\');
}

function bu(args) {
  const r = spawnSync('browser-use', ['--cdp-url', CDP, ...args], {
    encoding: 'utf8', timeout: 25000
  });
  return (r.stdout || '') + (r.stderr || '');
}

(async () => {
  const candidates = [];
  const perHandle = {};
  let scanned = 0, kept = 0, skippedAge = 0, skippedContent = 0, errors = 0, skippedReply = 0;
  const cutoff = Date.now() - hoursWindow * 3600 * 1000;

  for (const handle of handles) {
    scanned++;
    try {
      bu(['open', `https://x.com/${handle}`]);
      execSync('sleep 6');
      let out = bu(['eval', EVAL_JS]);
      let idx = out.indexOf('result:');
      let raw = idx === -1 ? '' : out.slice(idx + 7).trim();
      let posts = null;
      try { posts = JSON.parse(pyToJson(raw)); } catch (e) {}
      if (!posts || posts.length === 0) {
        const probe = bu(['eval', `document.body.innerText.includes('Something went wrong')`]);
        if (/true/i.test(probe)) {
          execSync('sleep 8');
          bu(['open', `https://x.com/${handle}`]);
          execSync('sleep 8');
          out = bu(['eval', EVAL_JS]);
          idx = out.indexOf('result:');
          raw = idx === -1 ? '' : out.slice(idx + 7).trim();
          try { posts = JSON.parse(pyToJson(raw)); } catch (e) {}
        }
      }
      if (!posts || posts.length === 0) { errors++; perHandle[handle] = 'empty'; process.stdout.write('x'); execSync('sleep 4'); continue; }
      let kfh = 0;
      for (const p of posts) {
        if (kfh >= maxPerHandle) break;
        if (!p.ts) continue;
        const ageMs = Date.now() - new Date(p.ts).getTime();
        if (ageMs > hoursWindow * 3600 * 1000) { skippedAge++; continue; }
        if (p.isRep || p.isRT) { skippedReply++; continue; }
        if (shouldSkip(p.tx)) { skippedContent++; continue; }
        const aria = p.aria || '';
        const num = (re) => { const m = aria.match(re); return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0; };
        const likes = num(/([\d,]+)\s+like/i);
        const replies = num(/([\d,]+)\s+repl/i);
        const reposts = num(/([\d,]+)\s+repost/i);
        const views = num(/([\d,]+)\s+view/i);
        candidates.push({
          handle, tweet_id: p.id, url: p.url,
          text: p.tx, created_at: p.ts,
          age_hours: Math.round(ageMs / 360000) / 10,
          likes, replies, reposts, views
        });
        kept++; kfh++;
      }
      perHandle[handle] = `ok(${kfh})`;
      process.stdout.write('.');
      execSync('sleep 4');
    } catch (e) {
      errors++; perHandle[handle] = 'exception'; process.stdout.write('x');
      execSync('sleep 4');
    }
  }
  console.log();

  candidates.sort((a, b) => {
    const sa = a.likes + a.replies * 2 + a.reposts * 3;
    const sb = b.likes + b.replies * 2 + b.reposts * 3;
    return sb - sa;
  });

  fs.writeFileSync(path.join(dir, 'candidates.json'), JSON.stringify({
    scraped_at: new Date().toISOString(),
    window_hours: hoursWindow,
    stats: { scanned, kept, skippedAge, skippedContent, skippedReply, errors },
    perHandle,
    candidates
  }, null, 2));
  console.log(`scanned=${scanned} kept=${kept} skipAge=${skippedAge} skipReply=${skippedReply} skipContent=${skippedContent} err=${errors}`);
  console.log(`wrote candidates.json (${candidates.length} candidates)`);
})();
