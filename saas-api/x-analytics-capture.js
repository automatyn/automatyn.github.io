// Capture X account-analytics network payloads from the already-logged-in
// openclaw-chrome via CDP. Robust against the DOM-tile wedge: we read the
// underlying XHR/GraphQL responses, not the rendered tiles.
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:18800', { timeout: 15000 });
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);

  const hits = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/analytics|insight|metric|impression|AccountAnalytics|organic|audience/i.test(url)) return;
    const ct = resp.headers()['content-type'] || '';
    if (!/json/.test(ct)) return;
    try {
      const body = await resp.json();
      const s = JSON.stringify(body);
      if (/impression|follower|engagement|profile_visit|metric|count/i.test(s)) {
        hits.push({ url: url.slice(0, 160), json: body });
      }
    } catch {}
  });

  try {
    await page.goto('https://x.com/i/account_analytics', { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) {
    console.log('goto note:', e.message);
  }
  await page.waitForTimeout(9000);

  // Also grab any visible numeric tiles as a fallback
  let domText = '';
  try {
    domText = await page.evaluate(() => (document.body.innerText || '').slice(0, 2500));
  } catch {}

  console.log('=== CAPTURED ANALYTICS RESPONSES:', hits.length, '===');
  for (const h of hits) {
    console.log('--- ' + h.url);
    console.log(JSON.stringify(h.json).slice(0, 3000));
  }
  console.log('=== DOM TEXT (fallback) ===');
  console.log(domText);

  await page.close();
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
