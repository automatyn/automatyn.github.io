#!/usr/bin/env node
// Pull a YouTube video transcript via the logged-in openclaw-chrome over raw CDP.
// Bypasses yt-dlp's bot-check by using the real authenticated browser session:
// navigate to the watch page, read the caption track URL from ytInitialPlayerResponse,
// fetch the timedtext in-page (same-origin, authed), return plain text.
// Usage: node yt-transcript.js <videoId>
const WebSocket = require('ws');
const http = require('http');

const VIDEO = process.argv[2];
if (!VIDEO) { console.error('usage: yt-transcript.js <videoId>'); process.exit(1); }

function hj(method, path) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: 18800, path, method }, x => {
      let d = ''; x.on('data', c => d += c); x.on('end', () => { try { res(JSON.parse(d)); } catch { res(d); } });
    });
    r.on('error', rej); r.end();
  });
}

(async () => {
  const tab = await hj('PUT', '/json/new?about:blank');
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  let id = 0; const p = {};
  const send = (m, par = {}) => new Promise(r => { const i = ++id; p[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: par })); });
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && p[m.id]) { p[m.id](m.result); delete p[m.id]; } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await send('Page.enable');
  await send('Page.navigate', { url: `https://www.youtube.com/watch?v=${VIDEO}` });
  await new Promise(r => setTimeout(r, 7000));

  // In-page: find the caption track, fetch it, return text. Try English first.
  const expr = `(async () => {
    try {
      const pr = window.ytInitialPlayerResponse;
      const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks || !tracks.length) return JSON.stringify({ ok:false, reason:'no_caption_tracks' });
      const en = tracks.find(t => (t.languageCode||'').startsWith('en')) || tracks[0];
      const r = await fetch(en.baseUrl + '&fmt=json3');
      const j = await r.json();
      const text = (j.events||[]).map(e => (e.segs||[]).map(s => s.utf8).join('')).join(' ').replace(/\\s+/g,' ').trim();
      const title = pr?.videoDetails?.title || '';
      return JSON.stringify({ ok:true, title, lang:en.languageCode, chars:text.length, text });
    } catch (e) { return JSON.stringify({ ok:false, reason:String(e) }); }
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const val = r?.result?.value;
  console.log(val || JSON.stringify({ ok:false, reason:'no_result' }));

  await hj('PUT', `/json/close/${tab.id}`).catch(() => {});
  ws.close();
  process.exit(0);
})().catch(e => { console.error(JSON.stringify({ ok:false, reason:e.message })); process.exit(1); });
