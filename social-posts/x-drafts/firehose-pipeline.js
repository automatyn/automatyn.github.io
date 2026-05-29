#!/usr/bin/env node
// X reply firehose: scrape via free sources only (no API credits), draft replies,
// push fresh batches to Telegram for manual tap-and-paste posting.
//
// Reuses existing scrapers:
//   - scrape-targets.js   (logged-in Chrome via CDP 18800)
//   - scrape-search.js    (logged-in Chrome via CDP 18800)
//   - firehose-fxt.js     (fxtwitter API, free)
// Then merges via draft-from-candidates.js, picks NEW drafts, and Telegrams them
// in batches with `tap:<id>` / `skip:<id>` callback prefix (distinct from the
// existing API-poster's `post:` prefix so the two pollers don't collide).
//
// Designed to be run every 30 min via systemd timer.
//
// Usage:
//   node firehose-pipeline.js                     # full run
//   node firehose-pipeline.js --batch-size=5      # smaller telegram batches
//   node firehose-pipeline.js --dry-run           # scrape + draft, no telegram

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const SOCIAL = path.join(DIR, '..');
const PENDING = path.join(SOCIAL, 'pending-x-drafts.json');
const SENT_LOG = path.join(SOCIAL, 'firehose-sent.json'); // ids we've already pushed
const STATS = path.join(SOCIAL, 'firehose-stats.json');

const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const BATCH = parseInt((args.find(a => a.startsWith('--batch-size=')) || '').split('=')[1], 10) || 5;
const MAX_PER_RUN = parseInt((args.find(a => a.startsWith('--max=')) || '').split('=')[1], 10) || 12;

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}Z] ${msg}`);
}

async function tgSend(text, replyMarkup) {
  const body = new URLSearchParams({
    chat_id: TG_CHAT,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
    reply_markup: JSON.stringify(replyMarkup),
  });
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || 'tg send failed');
  return j.result.message_id;
}

function runScraper(scriptName, scriptArgs = [], timeoutMs = 360000) {
  log(`scraping: ${scriptName} ${scriptArgs.join(' ')}`);
  const r = spawnSync('node', [path.join(DIR, scriptName), ...scriptArgs], {
    encoding: 'utf8',
    timeout: timeoutMs,
    cwd: DIR,
  });
  if (r.status !== 0) log(`  exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
  else log(`  ok (${(r.stdout || '').split('\n').filter(Boolean).pop() || ''})`);
  return r.status === 0;
}

async function main() {
  const startedAt = new Date().toISOString();
  log(`firehose-pipeline start (dry=${DRY}, batch=${BATCH}, max=${MAX_PER_RUN})`);

  // 1. Run free scrapers in sequence (they share the single Chrome — can't parallelise).
  // In dry-run mode, skip scraping and just re-merge whatever's already on disk.
  // Window 24h (was 6h) — many of our target handles post sporadically, 6h window
  // returned 0 candidates routinely. 24h covers the realistic posting cadence of
  // accounts like karpathy/AnthropicAI without flooding us. Recency filter still
  // happens downstream in draft-from-candidates.js if we tighten there.
  const scrapeResults = DRY ? { skipped: true } : {
    // Use Playwright-based scrape-targets-pw.js (the original browser-use CLI version
    // returned 0 candidates for unknown reason, even with logged-in chrome — confirmed
    // 2026-05-09). The pw version writes the same candidates-browser.json schema.
    targets: runScraper('scrape-targets-pw.js', ['24', '5'], 420000),
    search:  runScraper('scrape-search.js',  ['24'],     360000),
    fxt:     runScraper('firehose-fxt.js',   [],          60000),
  };
  log(`scrapers done: ${JSON.stringify(scrapeResults)}`);

  // 2. Run the keyword drafter (reads candidates-*.json, writes drafts.json).
  // SKIP_DRAFTER=1 bypasses this: the Claude reply-drafter trigger writes its own
  // reply drafts into drafts.json and then calls this pusher with SKIP_DRAFTER=1,
  // because the keyword drafter OVERWRITES drafts.json and would wipe those
  // Claude-written drafts before they are read (the bug that kept Telegram empty).
  if (process.env.SKIP_DRAFTER === '1') {
    log('SKIP_DRAFTER=1: not re-running keyword drafter, pushing existing drafts.json as-is.');
  } else {
    log('drafting from merged candidates...');
    const drafterRes = spawnSync('node', [path.join(DIR, 'draft-from-candidates.js'), 'firehose'], {
      encoding: 'utf8', timeout: 60000, cwd: DIR,
    });
    if (drafterRes.status !== 0) {
      log(`drafter failed: ${drafterRes.stderr || drafterRes.stdout}`);
      return;
    }
    log(drafterRes.stdout.split('\n').slice(-3).join(' | '));
  }

  // 3. Read drafts.json
  const draftsBundle = readJSON(path.join(DIR, 'drafts.json'), { drafts: [] });
  const allDrafts = draftsBundle.drafts || [];
  log(`drafts in drafts.json: ${allDrafts.length}`);

  // 4. Filter: only NEW reply-drafts we haven't pushed before.
  // NOTE: drafter writes drafts with field names {draft, target_url, target_handle, tweet_id};
  // we translate to pending-x-drafts.json schema {text, target, targetAuthor}.
  const sentLog = readJSON(SENT_LOG, { ids: [] });
  const sentIds = new Set(sentLog.ids);
  const seenTargets = new Set();
  // Big-account filter: only reply under 100K+ follower handles. Below that, algo
  // amplification is weak and you're wasting reply-bandwidth. Loaded from
  // handle-followers.json (refreshed daily by refresh-handle-followers.js).
  const FOLLOWER_FLOOR = parseInt(process.env.FIREHOSE_FOLLOWER_FLOOR, 10) || 100000;
  const handleFollowers = readJSON(path.join(DIR, 'handle-followers.json'), {});
  const newReplyDrafts = allDrafts.filter(d => {
    if (d.type !== 'reply') return false;
    const targetUrl = d.target_url || d.target;
    const draftText = d.draft || d.text;
    if (!targetUrl || !draftText) return false;
    if (draftText.length > 280) return false;
    // dedupe key: the tweet we're replying TO.
    const key = d.tweet_id || targetUrl;
    if (sentIds.has(key)) return false;
    if (seenTargets.has(key)) return false;
    // big-account filter: lookup handle's follower count, reject if below floor.
    // If we don't have data for the handle, prefer reject (safer than wasted reply).
    const handle = (d.target_handle || '').toLowerCase();
    const fdata = handleFollowers[handle];
    const followers = fdata?.followers || 0;
    if (followers < FOLLOWER_FLOOR) return false;
    seenTargets.add(key);
    return true;
  }).slice(0, MAX_PER_RUN);
  log(`big-account floor: ${FOLLOWER_FLOOR} followers — ${newReplyDrafts.length} of total drafts pass`);

  log(`new (un-pushed) reply drafts: ${newReplyDrafts.length}`);
  // Don't early-return here — we still want a QT chance even if all replies dedup'd.

  // 5. Append to pending-x-drafts.json with mode:'manual' so existing API poller skips them
  const pending = readJSON(PENDING, []);
  const newPending = newReplyDrafts.map(d => {
    const targetUrl = d.target_url || d.target;
    const tweetId = d.tweet_id || (targetUrl?.match(/status\/(\d+)/) || [])[1] || null;
    return {
      id: `f${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      type: 'reply',
      text: d.draft || d.text,
      target: targetUrl,
      targetAuthor: d.target_handle || d.targetAuthor || null,
      tweet_id: tweetId,
      reason: d.reason || null,
      created: new Date().toISOString(),
      slot: 'firehose',
      mode: 'manual',
    };
  });
  for (const p of newPending) pending.push(p);
  if (!DRY) writeJSON(PENDING, pending);

  // 5b. Quote-tweet candidates: pick top 1-2 highest-engagement big-account candidates
  // and emit a QT draft (post on Pat's profile, not buried under OP). QTs convert to
  // followers ~3x better than replies. Use a different draft template that stands alone.
  const QT_PER_CYCLE = parseInt(process.env.FIREHOSE_QT_PER_CYCLE, 10) || 1;
  const QT_TEMPLATES = [
    "The version of this nobody mentions: {hook}",
    "Worth re-reading. {hook}",
    "Counterpoint nobody wants to hear: {hook}",
    "Hard agree: {hook}",
    "Saving this. {hook}",
    "The honest version: {hook}",
  ];
  const QT_HOOKS = [
    "78% of buyers go with whoever replies first. Speed quietly became the only moat.",
    "Most SMBs lose £8-15k/year through unanswered calls. The plug matters more than the tap.",
    "The real lift in customer acquisition isn't more ads. It's reply-time.",
    "Service businesses that answer at 11pm beat the ones that don't, every quarter.",
    "Replying in 5 mins beats 5 hours by 21x in close-rate. Yet most still take 4 hours.",
    "Local trades don't need AI agents. They need an AI receptionist that doesn't call in sick.",
  ];
  const sortedByEngagement = (allDrafts || [])
    .filter(d => d.type === 'reply' && d.target_url && d.tweet_id && !sentIds.has(d.tweet_id))
    .map(d => ({ ...d, _eng: ((d.likes||0) + (d.replies||0)*2 + (d.reposts||0)*3) }))
    .filter(d => {
      const handle = (d.target_handle || '').toLowerCase();
      const f = handleFollowers[handle]?.followers || 0;
      return f >= FOLLOWER_FLOOR;
    })
    .sort((x, y) => y._eng - x._eng);
  const qtDrafts = [];
  for (let i = 0; i < Math.min(QT_PER_CYCLE, sortedByEngagement.length); i++) {
    const c = sortedByEngagement[i];
    const tmplIdx = i % QT_TEMPLATES.length;
    const hookIdx = (Date.now() / 60000 + i) | 0; // rotates over time
    const hook = QT_HOOKS[hookIdx % QT_HOOKS.length];
    const text = QT_TEMPLATES[tmplIdx].replace('{hook}', hook);
    if (text.length > 280) continue;
    qtDrafts.push({
      id: `q${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      type: 'quote',
      text,
      target: c.target_url,
      targetAuthor: c.target_handle,
      tweet_id: c.tweet_id,
      reason: 'quote-tweet',
      created: new Date().toISOString(),
      slot: 'firehose',
      mode: 'manual',
    });
  }
  for (const q of qtDrafts) pending.push(q);
  if (!DRY) writeJSON(PENDING, pending);
  log(`QT drafts: ${qtDrafts.length}`);

  // 6. Push to Telegram in batches (replies + QTs together)
  const allToPush = [...newPending, ...qtDrafts];
  if (DRY) {
    log(`DRY: would push ${allToPush.length} drafts to TG in batches of ${BATCH}`);
    for (const d of allToPush) log(`  [${d.type}] [${d.id}] @${d.targetAuthor}: ${d.text.slice(0, 80)}`);
  } else {
    let pushed = 0;
    for (const d of allToPush) {
      const isQT = d.type === 'quote';
      const header = isQT
        ? `🎯 QUOTE-TWEET → @${d.targetAuthor || 'thread'} (posts on YOUR profile)`
        : `🔥 FIREHOSE → @${d.targetAuthor || 'thread'}`;
      const msg = `${header}\n\n${d.text}\n\n<i>${d.text.length} chars · ${d.id} · ${d.type}</i>\n\n<a href="${d.target}">Source</a>`;
      // URL format differs:
      //   reply: ?in_reply_to=<id>&text=<draft>
      //   QT:    ?text=<draft>%20<encoded source URL>     (the URL inside the text makes it a QT)
      let intentUrl;
      if (isQT) {
        const qtBody = `${d.text} ${d.target}`;
        intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(qtBody)}`;
      } else if (d.tweet_id) {
        intentUrl = `https://x.com/intent/tweet?in_reply_to=${d.tweet_id}&text=${encodeURIComponent(d.text)}`;
      } else {
        intentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(d.text)}`;
      }
      const buttonLabel = isQT ? '🎯 Quote-tweet on X (pre-filled)' : '➡️ Reply on X (pre-filled)';
      const replyMarkup = {
        inline_keyboard: [
          [{ text: buttonLabel, url: intentUrl }],
          [
            { text: '✅ Sent it', callback_data: `tap:${d.id}` },
            { text: '❌ Skip',    callback_data: `skip:${d.id}` },
          ],
        ],
      };
      try {
        await tgSend(msg, replyMarkup);
        pushed++;
        if (d.tweet_id) sentLog.ids.push(d.tweet_id);
        sentLog.ids.push(d.id);
        await new Promise(r => setTimeout(r, 350));
      } catch (e) {
        log(`tg push failed for ${d.id}: ${e.message}`);
      }
    }
    log(`pushed ${pushed}/${allToPush.length} to TG (${newPending.length} replies + ${qtDrafts.length} QTs)`);
    if (sentLog.ids.length > 1000) sentLog.ids = sentLog.ids.slice(-1000);
    writeJSON(SENT_LOG, sentLog);
  }

  // 7. Update stats
  const stats = readJSON(STATS, { runs: [], totals: { pushed: 0 } });
  stats.runs.push({
    at: startedAt,
    scrapers: scrapeResults,
    drafts_in_bundle: allDrafts.length,
    new_pushed: DRY ? 0 : newPending.length,
  });
  if (stats.runs.length > 200) stats.runs = stats.runs.slice(-200);
  stats.totals.pushed = (stats.totals.pushed || 0) + (DRY ? 0 : newPending.length);
  if (!DRY) writeJSON(STATS, stats);

  log('firehose-pipeline done');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
