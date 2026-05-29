#!/usr/bin/env node
// Playwright replacement for the broken scrape-targets.js (which used browser-use CLI).
// Connects to Chrome at CDP 18800 directly — same logged-in session, no subprocess.
// Outputs candidates-browser.json with the same schema as the old scraper.

const fs = require('fs');
const path = require('path');

const dir = __dirname;
const targets = JSON.parse(fs.readFileSync(path.join(dir, 'target-list.json'), 'utf8'));
const hoursWindow = parseInt(process.argv[2] || '24', 10);
const maxPerHandle = parseInt(process.argv[3] || '5', 10);
const CDP = 'http://127.0.0.1:18800';

let handles = [];
const seen = new Set();
for (const group of Object.values(targets.groups)) for (const h of group) {
  if (!seen.has(h)) { seen.add(h); handles.push(h); }
}

// Rotation: the handle list outgrew a single paced scrape (80 handles x 10s
// exceeds the firehose 420s/run budget). Scrape a rotating slice each run and
// advance an offset so the full list is covered over a few runs. Override the
// slice size with SCRAPE_BATCH (default 25). Disable rotation with SCRAPE_BATCH=0.
const SCRAPE_BATCH = parseInt(process.env.SCRAPE_BATCH || '25', 10);
if (SCRAPE_BATCH > 0 && handles.length > SCRAPE_BATCH) {
  const stateFile = path.join(dir, 'scrape-rotation-state.json');
  let offset = 0;
  try { offset = JSON.parse(fs.readFileSync(stateFile, 'utf8')).offset || 0; } catch {}
  offset = offset % handles.length;
  const slice = [];
  for (let i = 0; i < SCRAPE_BATCH; i++) slice.push(handles[(offset + i) % handles.length]);
  const nextOffset = (offset + SCRAPE_BATCH) % handles.length;
  try { fs.writeFileSync(stateFile, JSON.stringify({ offset: nextOffset, total: handles.length, updated: new Date().toISOString() })); } catch {}
  console.log(`Rotation: scraping handles ${offset}-${offset + SCRAPE_BATCH - 1} of ${handles.length} (next offset ${nextOffset}).`);
  handles = slice;
}

const skipPatterns = [
  /^gm\b/i, /^gn\b/i, /\bgiveaway\b/i,
  /\b(crypto|airdrop|presale|memecoin)\b/i,
  /\b(dm me|telegram\.me)\b/i,
];

function shouldSkip(text) {
  if (!text) return true;
  if (text.length < 40) return true;
  for (const p of skipPatterns) if (p.test(text)) return true;
  return false;
}

(async () => {
  const { chromium } = require('playwright');
  console.log(`Scraping ${handles.length} handles, last ${hoursWindow}h, up to ${maxPerHandle} posts each`);

  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  if (!ctx) { console.error('no chrome context'); process.exit(1); }

  const cutoff = Date.now() - hoursWindow * 3600 * 1000;
  const candidates = [];
  const perHandle = {};
  let scanned = 0, kept = 0, skippedAge = 0, skippedContent = 0, skippedReply = 0, broken = 0, noRecent = 0;

  for (const handle of handles) {
    scanned++;
    perHandle[handle] = { kept: 0, found: 0, age_skip: 0, content_skip: 0, reply_skip: 0 };
    let page;
    try {
      page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      await page.goto(`https://x.com/${handle}`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3500);
      const posts = await page.evaluate(() => {
        const arts = Array.from(document.querySelectorAll('article')).slice(0, 8);
        return arts.map(a => {
          const u = a.querySelector('a[href*="/status/"]')?.href;
          const id = u ? (u.match(/status\/(\d+)/) || [])[1] : null;
          const ts = a.querySelector('time')?.getAttribute('datetime');
          const tx = a.querySelector('[data-testid="tweetText"]')?.innerText || '';
          const isRep = /^Replying to /m.test(a.innerText);
          const isRT = a.innerText.split('\n')[0].includes('reposted');
          const aria = a.querySelector('[role="group"]')?.getAttribute('aria-label') || '';
          return { id, ts, tx, isRep, isRT, aria, url: u };
        }).filter(x => x.id && x.tx);
      }).catch(() => []);
      perHandle[handle].found = posts.length;
      if (posts.length === 0) { broken++; process.stdout.write('!'); continue; }

      let perH = 0;
      for (const p of posts) {
        if (perH >= maxPerHandle) break;
        if (p.isRT) { perHandle[handle].content_skip++; skippedContent++; continue; }
        if (p.isRep) { perHandle[handle].reply_skip++; skippedReply++; continue; }
        const ageMs = Date.now() - new Date(p.ts).getTime();
        if (ageMs > hoursWindow * 3600 * 1000) { perHandle[handle].age_skip++; skippedAge++; continue; }
        if (shouldSkip(p.tx)) { perHandle[handle].content_skip++; skippedContent++; continue; }
        // Parse aria-label for likes/replies/reposts
        const ariaNums = (label, rx) => {
          const m = (p.aria || '').match(rx);
          if (!m) return 0;
          const n = m[1].replace(/[KkMm]/, '');
          let v = parseInt(n, 10) || 0;
          if (/k/i.test(m[1])) v *= 1000;
          if (/m/i.test(m[1])) v *= 1000000;
          return v;
        };
        const likes = ariaNums('likes', /(\d+(?:[\.,]\d+)?[KkMm]?)\s+likes?/);
        const replies = ariaNums('replies', /(\d+(?:[\.,]\d+)?[KkMm]?)\s+replies?/);
        const reposts = ariaNums('reposts', /(\d+(?:[\.,]\d+)?[KkMm]?)\s+(?:reposts?|retweets?)/);
        candidates.push({
          handle,
          tweet_id: p.id,
          id: p.id,
          url: p.url,
          text: p.tx.slice(0, 280),
          created_at: p.ts,
          age_hours: Math.round(ageMs / 36000) / 100,
          likes, replies, reposts,
        });
        perHandle[handle].kept++;
        perH++;
        kept++;
      }
      if (perH === 0 && posts.length > 0) noRecent++;
      process.stdout.write('.');
    } catch (err) {
      broken++;
      process.stdout.write('!');
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
  console.log();

  candidates.sort((a, b) => {
    const sa = (a.likes || 0) + (a.replies || 0) * 2 + (a.reposts || 0) * 3;
    const sb = (b.likes || 0) + (b.replies || 0) * 2 + (b.reposts || 0) * 3;
    return sb - sa;
  });

  fs.writeFileSync(path.join(dir, 'candidates-browser.json'), JSON.stringify({
    scraped_at: new Date().toISOString(),
    window_hours: hoursWindow,
    source: 'browser-handles-pw',
    stats: { scanned, kept, skippedAge, skippedContent, skippedReply, noRecent, broken },
    perHandle,
    candidates,
  }, null, 2));
  console.log(`scanned=${scanned} kept=${kept} skipAge=${skippedAge} skipReply=${skippedReply} skipContent=${skippedContent} noRecent=${noRecent} broken=${broken}`);
  console.log(`wrote candidates-browser.json (${candidates.length} candidates)`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
