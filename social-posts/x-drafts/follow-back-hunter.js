#!/usr/bin/env node
// Follow-back thread hunter.
// Searches X for active "say hey / follow back / follower train" threads,
// ranks by freshness + engagement, pushes top N to Telegram as one-tap
// intent URLs (text pre-loaded as "Hey").
//
// Strategy: target threads where the OP explicitly invites comments and
// promises follow-backs. These are mutual-follow farms that move the
// verified-follower count fast (Pat: 57 → 87 in 24h manually).
//
// Usage:
//   X_BEARER_TOKEN=... node follow-back-hunter.js [count] [age_hours]
//
// Reads: cost is 1 search call per query × ~6 queries = $0.03/run.

const fs = require('fs');
const path = require('path');

const BEARER = process.env.X_BEARER_TOKEN;
if (!BEARER) { console.error('X_BEARER_TOKEN not set'); process.exit(1); }
const COUNT = parseInt(process.argv[2] || '8', 10);
const AGE_HOURS = parseInt(process.argv[3] || '3', 10);

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT  = '5904617085';

const STATE_FILE = path.join(__dirname, 'follow-back-seen.json');
const seen = fs.existsSync(STATE_FILE) ? new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))) : new Set();

// Queries tuned for follow-back / mutual-follow threads.
// Each must hit X API v2 search/recent endpoint.
const QUERIES = [
  '"say hey" "follow back" -is:retweet -is:reply lang:en',
  '"say hi" "follow back" -is:retweet -is:reply lang:en',
  '"comment" "follow back" -is:retweet -is:reply lang:en',
  '"follower train" -is:retweet -is:reply lang:en',
  '"follow for follow" -is:retweet -is:reply lang:en',
  '"reply and i\'ll follow" -is:retweet -is:reply lang:en',
];

async function xSearch(query) {
  const startTime = new Date(Date.now() - AGE_HOURS * 3600 * 1000).toISOString();
  const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=50&start_time=${startTime}&tweet.fields=public_metrics,created_at,author_id&expansions=author_id&user.fields=public_metrics,verified,verified_type`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${BEARER}` } });
  if (!r.ok) {
    const t = await r.text();
    console.error(`Search ${r.status}: ${t.slice(0, 200)}`);
    return { data: [], includes: { users: [] } };
  }
  return r.json();
}

async function tg(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  });
  return (await r.json()).ok;
}

(async () => {
  const allTweets = [];
  const userMap = {};
  for (const q of QUERIES) {
    const j = await xSearch(q);
    for (const u of (j.includes?.users || [])) userMap[u.id] = u;
    for (const t of (j.data || [])) {
      if (seen.has(t.id)) continue;
      const author = userMap[t.author_id] || {};
      allTweets.push({ ...t, author, query: q });
    }
    await new Promise(r => setTimeout(r, 600)); // gentle on rate limit
  }

  // Dedupe by id (in case multiple queries hit same tweet)
  const uniq = new Map();
  for (const t of allTweets) if (!uniq.has(t.id)) uniq.set(t.id, t);
  const tweets = [...uniq.values()];

  // Rank: engagement (replies count strongest signal — more replies = bigger mutual-follow pool)
  // weight: replies × 3 + likes × 1 + reposts × 2, plus a small recency boost
  const now = Date.now();
  for (const t of tweets) {
    const m = t.public_metrics || {};
    const ageHrs = (now - new Date(t.created_at).getTime()) / 3600000;
    const recency = Math.max(0, AGE_HOURS - ageHrs); // newer = higher
    t._score = (m.reply_count || 0) * 3 + (m.like_count || 0) + (m.retweet_count || 0) * 2 + recency * 5;
    t._age_hours = ageHrs;
  }
  tweets.sort((a, b) => b._score - a._score);

  const top = tweets.slice(0, COUNT);
  if (top.length === 0) {
    await tg(`🐦 follow-back hunter: 0 fresh threads in last ${AGE_HOURS}h.`);
    console.log('No new threads.');
    return;
  }

  await tg(`🐦 ${top.length} fresh follow-back threads (last ${AGE_HOURS}h). Tap each, "Hey" is pre-loaded.`);
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const m = t.public_metrics || {};
    const handle = t.author?.username || 'unknown';
    const followers = t.author?.public_metrics?.followers_count || 0;
    const tweetUrl = `https://x.com/${handle}/status/${t.id}`;
    const replyHey = `https://x.com/intent/tweet?in_reply_to=${t.id}&text=${encodeURIComponent('Hey')}`;
    const replyHi = `https://x.com/intent/tweet?in_reply_to=${t.id}&text=${encodeURIComponent('Hi')}`;
    const msg = `${i+1}. @${handle} (${followers.toLocaleString()} followers, ${t._age_hours.toFixed(1)}h old)
Replies: ${m.reply_count} · Likes: ${m.like_count} · RTs: ${m.retweet_count}

Text: ${(t.text || '').slice(0, 200)}

🟢 Tap "Hey": ${replyHey}
🟢 Tap "Hi":  ${replyHi}
🔗 View thread: ${tweetUrl}`;
    await tg(msg);
    seen.add(t.id);
    await new Promise(r => setTimeout(r, 400));
  }

  // Cap state file at 500 ids (rolling window)
  const seenArr = [...seen].slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(seenArr, null, 2));
  console.log(`Pushed ${top.length} threads. seen-cache: ${seenArr.length}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
