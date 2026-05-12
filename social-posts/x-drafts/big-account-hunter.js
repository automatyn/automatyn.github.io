#!/usr/bin/env node
// Big-account live-feed hunter.
// Pulls <30min-old tweets from >100k follower accounts (target-list.json
// filtered by handle-followers.json), pushes each to Telegram with a
// one-line "what makes a good reply here" hint + the intent URL skeleton.
//
// NO canned reply drafts — yesterday's lesson was that template replies
// are bot-tier. Pat writes the actual reply himself (3-30 seconds tap)
// because the algo window for first-reply impressions is short.
//
// Strategy: reply-back from a >100k account = ~150x impressions.
// One landing per day at this level = ~50k impressions = closes the gap
// to 5M/90d significantly.
//
// Usage:
//   X_BEARER_TOKEN=... node big-account-hunter.js [age_minutes] [follower_floor]

const fs = require('fs');
const path = require('path');

const BEARER = process.env.X_BEARER_TOKEN;
if (!BEARER) { console.error('X_BEARER_TOKEN not set'); process.exit(1); }
const AGE_MIN = parseInt(process.argv[2] || '30', 10);
const FOLLOWER_FLOOR = parseInt(process.argv[3] || '100000', 10);

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT  = '5904617085';

const dir = __dirname;
const SEEN_FILE = path.join(dir, 'big-account-seen.json');
const seen = fs.existsSync(SEEN_FILE) ? new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))) : new Set();

// Load replied-cache so we don't suggest tweets Pat already replied to
const repliedFile = path.join(dir, 'replied-cache.json');
const alreadyReplied = new Set();
if (fs.existsSync(repliedFile)) {
  const c = JSON.parse(fs.readFileSync(repliedFile, 'utf8'));
  for (const id of (c.replied_to || [])) alreadyReplied.add(String(id));
}

// Build the >100k handle list from cache
const followerCache = JSON.parse(fs.readFileSync(path.join(dir, 'handle-followers.json'), 'utf8'));
const targetList = JSON.parse(fs.readFileSync(path.join(dir, 'target-list.json'), 'utf8'));
const allHandles = [];
for (const group of Object.values(targetList.groups)) for (const h of group) {
  const cached = followerCache[h.toLowerCase()] || followerCache[h];
  if (cached && cached.followers >= FOLLOWER_FLOOR) allHandles.push(h);
}
console.log(`${allHandles.length} handles >${FOLLOWER_FLOOR.toLocaleString()} followers from target-list.`);

// Build query: from:handle1 OR from:handle2 ... chunked to <480 chars
function chunkHandles(handles, maxChars = 460) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const h of handles) {
    const segLen = `from:${h} OR `.length;
    if (curLen + segLen > maxChars) {
      if (cur.length) chunks.push(cur);
      cur = [h];
      curLen = segLen;
    } else {
      cur.push(h);
      curLen += segLen;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function xSearch(handles) {
  const fromQuery = handles.map(h => `from:${h}`).join(' OR ');
  const query = `(${fromQuery}) -is:retweet -is:reply lang:en`;
  const startTime = new Date(Date.now() - AGE_MIN * 60 * 1000).toISOString();
  const fields = 'public_metrics,created_at,author_id';
  const expansions = 'author_id';
  const userFields = 'username,public_metrics';
  const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=50&start_time=${startTime}&tweet.fields=${fields}&expansions=${expansions}&user.fields=${userFields}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${BEARER}` } });
  if (!r.ok) {
    console.error('Search', r.status, (await r.text()).slice(0, 200));
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

function replyAnglePrompt(text) {
  // Short hint about WHAT kind of reply lands well, NOT a draft.
  // The hint is angle-only so Pat writes his own line.
  if (/\?/.test(text)) return '🎯 Author asked a question. Answer it specifically + offer a counter-question.';
  if (/(unpopular|controversial|hot take|hottake|disagree|nobody|underrated|overrated)/i.test(text)) return '🎯 Contrarian flag in their post. Counter their counter or sharpen one of their points.';
  if (/\b(launch|launched|shipped|releasing|announcing|excited to)/i.test(text)) return '🎯 Launch post. Skip generic congrats. Ask a specific deployment/usage question.';
  if (/(why|how|when|where).{0,20}(does|do|is|are|don|doesn)/i.test(text)) return '🎯 Open question framing. Drop a 1-sentence answer + your own evidence.';
  if (/\b(number|percent|%|\d{2,}|x times|times more)/i.test(text)) return '🎯 They cited a number. Cite a counter-number, or break down what their number hides.';
  return '🎯 Goal: reply-back from author. Direct question to them about THEIR data/experience. <200ch.';
}

(async () => {
  const chunks = chunkHandles(allHandles);
  const allTweets = [];
  const userMap = {};
  for (const c of chunks) {
    const j = await xSearch(c);
    for (const u of (j.includes?.users || [])) userMap[u.id] = u;
    for (const t of (j.data || [])) {
      if (seen.has(t.id) || alreadyReplied.has(String(t.id))) continue;
      const author = userMap[t.author_id] || {};
      allTweets.push({ ...t, author });
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // Rank: prefer fresh + early engagement (likes/replies coming in fast = algo lift signal)
  const now = Date.now();
  for (const t of allTweets) {
    const m = t.public_metrics || {};
    const ageMin = (now - new Date(t.created_at).getTime()) / 60000;
    const followers = t.author?.public_metrics?.followers_count || 0;
    t._age_min = ageMin;
    // Freshness premium: <10min is gold (algo first-reply slot)
    const freshnessScore = ageMin < 10 ? 30 : ageMin < 20 ? 15 : 5;
    t._score = freshnessScore + (m.like_count || 0) + (m.reply_count || 0) * 2 + (followers / 100000);
  }
  allTweets.sort((a, b) => b._score - a._score);

  const top = allTweets.slice(0, 8);
  if (top.length === 0) {
    await tg(`🎯 big-account hunter: 0 fresh tweets from >${FOLLOWER_FLOOR.toLocaleString()}-follower targets in last ${AGE_MIN}min.`);
    console.log('No new tweets.');
    return;
  }

  await tg(`🎯 ${top.length} BIG-ACCOUNT tweets <${AGE_MIN}min old (>${FOLLOWER_FLOOR.toLocaleString()}f).\nReply now = algo first-reply slot = max impressions. Write YOUR OWN line — no templates.`);
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const m = t.public_metrics || {};
    const handle = t.author?.username || 'unknown';
    const followers = t.author?.public_metrics?.followers_count || 0;
    const tweetUrl = `https://x.com/${handle}/status/${t.id}`;
    const intent = `https://x.com/intent/tweet?in_reply_to=${t.id}`;
    const hint = replyAnglePrompt(t.text || '');
    const msg = `${i+1}. @${handle} (${(followers/1000).toFixed(0)}k followers, ${t._age_min.toFixed(0)}min old)
Likes: ${m.like_count} · Replies: ${m.reply_count} · RTs: ${m.retweet_count}

POST: ${(t.text || '').slice(0, 280)}

${hint}

🔗 Thread: ${tweetUrl}
✍️ Reply (intent URL, write your line in the box): ${intent}`;
    await tg(msg);
    seen.add(t.id);
    await new Promise(r => setTimeout(r, 400));
  }

  // Cap state file at 1000 ids
  const seenArr = [...seen].slice(-1000);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seenArr, null, 2));
  console.log(`Pushed ${top.length} big-account tweets. seen-cache: ${seenArr.length}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
