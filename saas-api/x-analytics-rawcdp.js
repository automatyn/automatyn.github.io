// Raw CDP capture of X account-analytics network payloads. Bypasses Playwright
// (which times out negotiating the saturated browser-level WS on Chrome 147) by
// driving a single fresh page target over its own page-level WebSocket.
const WebSocket = require('ws');
const http = require('http');

const CDP = '127.0.0.1:18800';
const TARGET_URL = 'https://x.com/i/account_analytics';

function httpJson(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 18800, path, method }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  // 1. Open a fresh tab
  const tab = await httpJson('PUT', '/json/new?about:blank');
  const wsUrl = tab.webSocketDebuggerUrl || `ws://${CDP}/devtools/page/${tab.id}`;
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });

  let id = 0;
  const pending = {};
  const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending[mid] = resolve; ws.send(JSON.stringify({ id: mid, method, params })); });

  const interesting = /analytics|insight|metric|impression|AccountAnalytics|organic|audience|Engagement/i;
  const requests = {};   // requestId -> url
  const captured = [];

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
    if (msg.method === 'Network.responseReceived') {
      const { requestId, response } = msg.params;
      if (interesting.test(response.url) && /json/i.test(response.mimeType || '')) requests[requestId] = response.url;
    }
    if (msg.method === 'Network.loadingFinished') {
      const rid = msg.params.requestId;
      if (requests[rid]) {
        const url = requests[rid]; delete requests[rid];
        const body = await send('Network.getResponseBody', { requestId: rid }).catch(() => null);
        if (body && body.body) {
          const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
          if (/impression|follower|engagement|profile_visit|metric|count/i.test(text)) {
            captured.push({ url: url.slice(0, 160), text: text.slice(0, 6000) });
          }
        }
      }
    }
  });

  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await send('Network.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: TARGET_URL });

  // wait for XHRs to fire
  await new Promise(r => setTimeout(r, 12000));

  // Pull rendered text as a fallback
  const domRes = await send('Runtime.evaluate', { expression: '(document.body && document.body.innerText || "").slice(0,3000)', returnByValue: true }).catch(() => null);
  const domText = domRes && domRes.result ? domRes.result.value : '';

  console.log('=== CAPTURED:', captured.length, 'analytics responses ===');
  for (const c of captured) { console.log('--- ' + c.url); console.log(c.text); }
  console.log('=== DOM TEXT (fallback) ===');
  console.log(domText);

  await httpJson('PUT', `/json/close/${tab.id}`).catch(() => {});
  ws.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
