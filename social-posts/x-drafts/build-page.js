#!/usr/bin/env node
// Reads drafts.json from same dir, renders index.html scroll-page.
// drafts.json shape: {slot, date, drafts:[{id, type:'reply'|'original', target_handle, target_followers, target_age, target_text, target_url, tweet_id, draft, char_count, reason}]}

const fs = require('fs');
const path = require('path');

const dir = path.dirname(process.argv[1]);
const inputPath = process.argv[2] || path.join(dir, 'drafts.json');
const outputPath = process.argv[3] || path.join(dir, 'index.html');
const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const enc = s => encodeURIComponent(s);

const intentUrl = d => d.type === 'reply'
  ? `https://x.com/intent/tweet?in_reply_to=${d.tweet_id}&text=${enc(d.draft)}`
  : `https://x.com/intent/tweet?text=${enc(d.draft)}`;

const escapeHtml = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cardHtml = (d, i) => `
<div class="card" data-id="${d.id}" id="card-${d.id}">
  <div class="card-head">
    <span class="num">#${i + 1}</span>
    <span class="badge ${d.type}">${d.type.toUpperCase()}</span>
    ${d.target_handle ? `<span class="meta">@${escapeHtml(d.target_handle)}</span>` : ''}
    ${d.target_followers != null ? `<span class="meta">${d.target_followers}f</span>` : ''}
    ${d.target_age ? `<span class="meta">${escapeHtml(d.target_age)}</span>` : ''}
    <span class="char-count">${d.char_count}c</span>
  </div>
  ${d.target_text ? `<div class="target"><a href="${d.target_url}" target="_blank">view post →</a><div class="target-text">${escapeHtml(d.target_text)}</div></div>` : ''}
  <div class="draft-text">${escapeHtml(d.draft)}</div>
  ${d.reason ? `<div class="reason">${escapeHtml(d.reason)}</div>` : ''}
  <div class="actions">
    <a class="post-btn" href="${intentUrl(d)}" target="_blank" onclick="markDone('${d.id}')">📤 Post</a>
    <button class="skip-btn" onclick="markSkipped('${d.id}')">Skip</button>
  </div>
</div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>X drafts — ${data.slot} ${data.date}</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e5e5e5; margin: 0; padding: 16px; max-width: 720px; margin: 0 auto; }
header { position: sticky; top: 0; background: #0a0a0a; padding: 12px 0; border-bottom: 1px solid #222; z-index: 10; }
h1 { font-size: 20px; margin: 0 0 8px; }
.progress { font-size: 14px; color: #a855f7; }
.card { background: #141414; border: 1px solid #222; border-radius: 12px; padding: 14px; margin: 12px 0; transition: opacity 0.3s; }
.card.done { opacity: 0.35; border-color: #16a34a; }
.card.skipped { opacity: 0.25; border-color: #444; }
.card-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; margin-bottom: 8px; }
.num { color: #666; font-weight: 600; }
.badge { padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; }
.badge.reply { background: #1e3a8a; color: #93c5fd; }
.badge.original { background: #581c87; color: #c4b5fd; }
.meta { color: #888; }
.char-count { margin-left: auto; color: #888; font-variant-numeric: tabular-nums; }
.target { background: #1a1a1a; border-left: 3px solid #3b82f6; padding: 8px 10px; margin: 8px 0; border-radius: 4px; font-size: 13px; }
.target a { color: #60a5fa; font-size: 11px; text-decoration: none; }
.target-text { color: #aaa; margin-top: 4px; }
.draft-text { background: #0f0f0f; border: 1px solid #2a2a2a; padding: 12px; border-radius: 8px; font-size: 15px; line-height: 1.45; white-space: pre-wrap; margin: 10px 0; }
.reason { font-size: 11px; color: #666; font-style: italic; margin: 6px 0 10px; }
.actions { display: flex; gap: 8px; margin-top: 10px; }
.post-btn { flex: 1; background: #1d9bf0; color: white; padding: 12px; border-radius: 999px; text-align: center; text-decoration: none; font-weight: 600; font-size: 15px; }
.post-btn:active { background: #1a8cd8; }
.skip-btn { background: transparent; color: #888; border: 1px solid #333; padding: 12px 18px; border-radius: 999px; font-size: 14px; cursor: pointer; }
.reset { background: transparent; border: none; color: #666; font-size: 12px; cursor: pointer; text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>X drafts — ${data.slot} ${data.date}</h1>
  <div class="progress"><span id="done-count">0</span>/${data.drafts.length} posted · <span id="skipped-count">0</span> skipped · <button class="reset" onclick="resetState()">reset</button></div>
</header>
<div id="cards">
${data.drafts.map(cardHtml).join('\n')}
</div>
<script>
const KEY = 'x-drafts-${data.slot}-${data.date}';
const state = JSON.parse(localStorage.getItem(KEY) || '{}');
function refresh() {
  let done = 0, skipped = 0;
  document.querySelectorAll('.card').forEach(c => {
    const id = c.dataset.id;
    c.classList.remove('done', 'skipped');
    if (state[id] === 'done') { c.classList.add('done'); done++; }
    if (state[id] === 'skipped') { c.classList.add('skipped'); skipped++; }
  });
  document.getElementById('done-count').textContent = done;
  document.getElementById('skipped-count').textContent = skipped;
}
function markDone(id) { state[id] = 'done'; localStorage.setItem(KEY, JSON.stringify(state)); refresh(); }
function markSkipped(id) { state[id] = 'skipped'; localStorage.setItem(KEY, JSON.stringify(state)); refresh(); }
function resetState() { if (confirm('Reset all progress?')) { localStorage.removeItem(KEY); location.reload(); } }
refresh();
</script>
</body>
</html>`;

fs.writeFileSync(outputPath, html);
console.log(`wrote ${outputPath} (${data.drafts.length} drafts)`);
