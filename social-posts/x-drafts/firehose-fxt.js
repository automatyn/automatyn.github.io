#!/usr/bin/env node
// Polls latest tweet from a list of high-volume accounts via fxtwitter (free).
// Filters: <hoursWindow old, not a reply, not a repost.
// Usage: node firehose-fxt.js [hoursWindow]   (default 3)

const fs = require('fs');
const path = require('path');
const https = require('https');

const dir = __dirname;
const hoursWindow = parseInt(process.argv[2] || '3', 10);

// NOTE: levelsio removed 2026-05-29 — replies to @patrickssons are restricted on
// his account (the compose box does not open), so drafting replies to him wastes
// the slot. Do not re-add. See memory feedback_x_levelsio_replies_restricted.
const handles = [
  'sama','jasonlk','naval','balajis','paulg','dhh','swyx',
  'karpathy','simonw','rauchg','GergelyOrosz','patio11','marc_louvion',
  'arvidkahl','jonyongfook','nikitabier','sahilbloom','dvassallo','mckaywrigley',
  'AravSrinivas','amasad','hnshah','OpenAIDevs','AnthropicAI','alexalbert__',
  'shawnchauhan1','TKopelman','AishwaryaDevv','Duemers_',
  // Migrated from target-list.json (scrape-targets-pw disabled due to X rate-limit on browser session)
  'gregisenberg','lennysan','dharmesh','harryjdry','csallen','mijustin',
  'MahlumAI','rxhit05','TTrimoreau','aminnnn_09',
  // 2026-05-13 expansion: 12 verified handles via fxtwitter (3.7k-361k followers)
  'adamwathan','steventey','theprimeagen','iannuttall','marckohlbrugge',
  'jasonleowsg','tdinh_me','natfriedman','cjzafir','damengchen','peer_rich','t3dotgg',
];

function fxtFetch(handle) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.fxtwitter.com',
      path: `/2/profile/${handle}/statuses`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; firehose-bot/1.0)' }
    };
    https.get(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  const out = [];
  let scanned = 0, kept = 0, skipAge = 0, skipReply = 0, skipNoTweet = 0, broken = 0;
  const cutoff = Date.now() - hoursWindow * 3600 * 1000;

  console.log(`Polling ${handles.length} firehose accounts, last ${hoursWindow}h...`);

  for (const h of handles) {
    scanned++;
    const d = await fxtFetch(h);
    const results = d && Array.isArray(d.results) ? d.results : null;
    if (!results || results.length === 0) { broken++; process.stdout.write('!'); continue; }

    let kept_one = false;
    for (const tweet of results) {
      if (!tweet || !tweet.id) { continue; }
      const ts = tweet.created_timestamp ? tweet.created_timestamp * 1000 : Date.parse(tweet.created_at);
      if (!ts) continue;
      if (ts < cutoff) { skipAge++; continue; }
      const text = tweet.text || '';
      if (text.startsWith('RT @') || tweet.replying_to || tweet.is_reply) { skipReply++; continue; }
      const author = tweet.author || {};
      out.push({
        handle: author.screen_name || h,
        author_followers: author.followers || 0,
        tweet_id: tweet.id,
        url: tweet.url,
        text: text.slice(0, 400),
        created_at: tweet.created_at,
        age_hours: Math.round((Date.now() - ts) / 360000) / 10,
        likes: tweet.likes || 0,
        replies: tweet.replies || 0,
        reposts: tweet.reposts || tweet.retweets || 0,
        views: tweet.views || 0,
        source: 'firehose'
      });
      kept++;
      kept_one = true;
    }
    if (kept_one) process.stdout.write('.');
    else { skipNoTweet++; process.stdout.write('-'); }
  }
  console.log();

  out.sort((a, b) => b.author_followers - a.author_followers);

  fs.writeFileSync(path.join(dir, 'firehose-candidates.json'), JSON.stringify({
    scraped_at: new Date().toISOString(),
    hours_window: hoursWindow,
    stats: { scanned, kept, skipAge, skipReply, skipNoTweet, broken },
    candidates: out
  }, null, 2));

  console.log(`scanned=${scanned} kept=${kept} skipAge=${skipAge} skipReply=${skipReply} skipNoTweet=${skipNoTweet} broken=${broken}`);
  console.log(`legend: . kept | - skipped | ! broken`);
  console.log(`wrote firehose-candidates.json (${out.length} candidates)`);
})();
