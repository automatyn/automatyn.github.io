#!/usr/bin/env node
// Polls latest tweet from a list of high-volume accounts via fxtwitter (free).
// Filters: <hoursWindow old, not a reply, not a repost.
// Usage: node firehose-fxt.js [hoursWindow]   (default 3)

const fs = require('fs');
const path = require('path');
const https = require('https');

const dir = __dirname;
const hoursWindow = parseInt(process.argv[2] || '3', 10);

const handles = [
  'sama','levelsio','jasonlk','naval','balajis','paulg','dhh','swyx',
  'karpathy','simonw','rauchg','GergelyOrosz','patio11','marc_louvion',
  'arvidkahl','jonyongfook','nikitabier','sahilbloom','dvassallo','mckaywrigley',
  'AravSrinivas','amasad','hnshah','OpenAIDevs','AnthropicAI','alexalbert__',
  'shawnchauhan1','TKopelman','AishwaryaDevv','Duemers_'
];

function fxtFetch(handle) {
  return new Promise((resolve) => {
    https.get(`https://api.fxtwitter.com/${handle}`, (res) => {
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
    if (!d || !d.user) { broken++; process.stdout.write('!'); continue; }
    const user = d.user;
    const tweet = d.tweet || (d.user && d.user.last_tweet);
    if (!tweet || !tweet.id) { skipNoTweet++; process.stdout.write('-'); continue; }
    const ts = tweet.created_timestamp ? tweet.created_timestamp * 1000 : Date.parse(tweet.created_at);
    if (!ts || ts < cutoff) { skipAge++; process.stdout.write('-'); continue; }
    const text = tweet.text || '';
    if (text.startsWith('RT @') || tweet.replying_to) { skipReply++; process.stdout.write('-'); continue; }
    out.push({
      handle: user.screen_name,
      author_followers: user.followers,
      tweet_id: tweet.id,
      url: tweet.url,
      text: text.slice(0, 400),
      created_at: tweet.created_at,
      age_hours: Math.round((Date.now() - ts) / 360000) / 10,
      likes: tweet.likes || 0,
      replies: tweet.replies || 0,
      reposts: tweet.retweets || 0,
      views: tweet.views || 0,
      source: 'firehose'
    });
    kept++;
    process.stdout.write('.');
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
