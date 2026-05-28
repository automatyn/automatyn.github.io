// Connect to running openclaw-chrome via CDP, open X analytics,
// and CAPTURE the underlying analytics API/XHR responses (not the DOM tiles).
// The DOM-scrape version wedges when tiles fail to render; the network payload
// carries the numbers regardless. Prints captured JSON blobs + a DOM fallback.
const { chromium } = require('playwright');

const INTERESTING = /account_analytics|AccountAnalytics|UserBusinessProfile|analytics|impression|organic_metrics|metrics|insights|AudienceInsights|creator/i;

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:18800');
  const ctx = browser.contexts()[0];
  if (!ctx) { console.error('No context'); process.exit(1); }
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);

  const captured = [];
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!INTERESTING.test(url)) return;
      const ct = resp.headers()['content-type'] || '';
      if (!/json/.test(ct)) return;
      const body = await resp.json().catch(() => null);
      if (!body) return;
      const s = JSON.stringify(body);
      // Only keep payloads that smell like metrics
      if (/impression|follower|engagement|profile_visit|metric|count/i.test(s)) {
        captured.push({ url: url.slice(0, 140), size: s.length, body });
      }
    } catch {}
  });

  console.log('Navigating to /i/account_analytics ...');
  try {
    await page.goto('https://x.com/i/account_analytics', { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    console.log('goto note (continuing):', e.message);
  }
  // Give XHRs time to fire and try clicking through time-range if present
  await page.waitForTimeout(8000);

  await page.screenshot({ path: '/tmp/x-analytics2.png', fullPage: true }).catch(() => {});

  // DOM fallback text
  const dom = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 80);
  }).catch(() => []);

  console.log('=== CAPTURED ANALYTICS PAYLOADS:', captured.length, '===');
  for (const c of captured) {
    console.log('--- URL:', c.url, '(', c.size, 'bytes) ---');
    // Print a trimmed view so we can find the metric keys
    const flat = JSON.stringify(c.body);
    console.log(flat.slice(0, 4000));
  }

  console.log('=== DOM TEXT (fallback, first 80 lines) ===');
  for (const l of dom) console.log(l);

  await page.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
