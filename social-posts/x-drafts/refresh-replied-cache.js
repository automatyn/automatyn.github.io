#!/usr/bin/env node
// Pulls Pat's last ~100 tweets and writes a cache of tweet_ids he's replied to.
// The drafter reads replied-cache.json and skips any candidate that matches.
// Cheap: 1 read per run ($0.005).

const fs = require('fs');
const path = require('path');

const BEARER = process.env.X_BEARER_TOKEN;
if (!BEARER) {
  console.error('X_BEARER_TOKEN not set');
  process.exit(1);
}
const USER_ID = '153945388';

(async () => {
  const url = `https://api.twitter.com/2/users/${USER_ID}/tweets?max_results=100&tweet.fields=referenced_tweets,created_at&exclude=retweets`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${BEARER}` } });
  if (!r.ok) { console.error('X API error', r.status, await r.text()); process.exit(1); }
  const j = await r.json();
  const replied = new Set();
  for (const t of (j.data || [])) {
    for (const ref of (t.referenced_tweets || [])) {
      if (ref.type === 'replied_to' && ref.id) replied.add(ref.id);
    }
  }
  const out = {
    updated_at: new Date().toISOString(),
    replied_to: Array.from(replied),
  };
  fs.writeFileSync(path.join(__dirname, 'replied-cache.json'), JSON.stringify(out, null, 2));
  console.log(`Cached ${out.replied_to.length} replied-to tweet ids.`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
