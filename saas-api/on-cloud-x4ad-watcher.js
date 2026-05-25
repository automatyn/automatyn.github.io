#!/usr/bin/env node
// On Cloud X 4 AD White/Wolf price watcher via CDP 18800.
// Pings Telegram when price hits target. One-shot per drop episode.
//
// Usage: node on-cloud-x4ad-watcher.js   (from systemd timer every 30 min)

const fs = require('fs');
const https = require('https');
const http = require('http');
const WebSocket = require('/home/marketingpatpat/node_modules/ws');

const URL = 'https://www.on.com/en-gb/products/cloud-x-4-ad-3mf1026/mens/white-wolf-shoes-3MF10262852';
const PRODUCT_NAME = 'On Cloud X 4 AD (White/Wolf, mens)';
const TARGET_PRICE = 95.00; // GBP
const TARGET_SIZE = '9'; // UK size to watch for stock
const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';
const STATE_FILE = '/home/marketingpatpat/openclaw/saas-api/on-cloud-x4ad-state.json';
const CDP = 'http://localhost:18800';

function getTabs() {
  return new Promise((resolve, reject) => {
    http.get(`${CDP}/json`, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function tg(msg) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: false });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(body); req.end();
  });
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { alertedAt: null, lastPrice: null, runs: 0 };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { alertedAt: null, lastPrice: null, runs: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function scrapePrice() {
  const tabs = await getTabs();
  const tab = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!tab) throw new Error('No CDP page tab available');

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let msgId = 1;
  const pending = new Map();
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = msgId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  await new Promise(r => ws.on('open', r));
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });

  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await new Promise(r => setTimeout(r, 10000));

  // Cookie banner if present
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find(b => /accept|agree|allow|got it|ok/i.test(b.innerText || b.value || ''));
        if (btn) { btn.click(); return 'clicked'; }
        return 'no-banner';
      })()
    `,
    returnByValue: true,
  });
  await new Promise(r => setTimeout(r, 3000));

  const result = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const main = document.querySelector('main, [role="main"], #__next') || document.body;
        const txt = (main.innerText || '');
        const out = { url: location.href };
        out.title = (document.querySelector('h1')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
        // On.com structure: "Current price\\n£110.00\\noriginal price\\n£140.00"
        const cur = txt.match(/Current price[^£]{0,40}£\\s?([0-9]+(?:\\.[0-9]{1,2})?)/i);
        const orig = txt.match(/original price[^£]{0,40}£\\s?([0-9]+(?:\\.[0-9]{1,2})?)/i);
        if (cur) out.currentPrice = parseFloat(cur[1]);
        if (orig) out.originalPrice = parseFloat(orig[1]);
        if (out.currentPrice == null) {
          const m = txt.match(/£\\s?([0-9]+(?:\\.[0-9]{1,2})?)/);
          if (m) out.currentPrice = parseFloat(m[1]);
        }
        // Per-size stock map
        const sizeMap = {};
        const spans = Array.from(document.querySelectorAll('[class*="sizeValue"]'));
        for (const s of spans) {
          const sizeLabel = (s.innerText || '').trim();
          if (!/^[0-9]+(\\.[0-9])?$/.test(sizeLabel)) continue;
          let el = s; let depth = 0;
          while (el && depth < 6) { if (el.tagName === 'BUTTON') break; el = el.parentElement; depth++; }
          const cls = el && typeof el.className === 'string' ? el.className : '';
          const btnTxt = (el?.innerText || '').toLowerCase();
          const oos = /no items left|notify me|sold out|out of stock/i.test(btnTxt) || /OutOfStock/i.test(cls);
          const lowMatch = btnTxt.match(/only\\s+(\\d+)\\s+left/i);
          sizeMap[sizeLabel] = oos ? 'OUT' : (lowMatch ? 'LOW:'+lowMatch[1] : 'IN');
        }
        out.sizes = sizeMap;
        out.totalSizes = Object.keys(sizeMap).length;
        out.inStockSizes = Object.entries(sizeMap).filter(([,v]) => v !== 'OUT').map(([k]) => k);
        return out;
      })()
    `,
    returnByValue: true,
  });
  ws.close();
  return result.result?.result?.value || {};
}

async function run() {
  const state = loadState();
  state.runs = (state.runs || 0) + 1;

  let info;
  try {
    info = await scrapePrice();
  } catch (e) {
    console.error(`[run ${state.runs}] scrape failed:`, e.message);
    state.lastError = e.message;
    state.lastErrorAt = new Date().toISOString();
    saveState(state);
    process.exit(1);
  }

  if (info.currentPrice == null) {
    console.log(`[run ${state.runs}] no price extracted. title="${info.title}"`);
    state.lastNoPrice = new Date().toISOString();
    saveState(state);
    return;
  }

  const ts = new Date().toISOString();
  const origNote = info.originalPrice ? ` (RRP £${info.originalPrice.toFixed(2)})` : '';
  const sizeStatus = info.sizes?.[TARGET_SIZE] || 'NOT_FOUND';
  console.log(`[run ${state.runs}] ${ts} title="${info.title}" price=£${info.currentPrice.toFixed(2)}${origNote} target=£${TARGET_PRICE.toFixed(2)} size${TARGET_SIZE}=${sizeStatus} inStock=[${info.inStockSizes?.join(',')}]`);
  state.lastPrice = info.currentPrice;
  state.lastOriginalPrice = info.originalPrice || null;
  state.lastTitle = info.title;
  state.lastCheckAt = ts;
  state.lastError = null;
  state.lastSizeStatus = sizeStatus;
  state.lastInStockSizes = info.inStockSizes || [];

  const sizeInStock = sizeStatus !== 'OUT' && sizeStatus !== 'NOT_FOUND';
  const priceHitsTarget = info.currentPrice <= TARGET_PRICE;

  // STOCK-RETURN ALERT: size 9 was out, now in stock
  if (sizeInStock && state.lastSizeStatus_persisted === 'OUT') {
    const stockAlertedRecent = state.stockAlertedAt && (Date.now() - Date.parse(state.stockAlertedAt)) < 24 * 3600 * 1000;
    if (!stockAlertedRecent) {
      const lowNote = sizeStatus.startsWith('LOW:') ? ` (${sizeStatus.replace('LOW:', 'only ')} left, move fast)` : '';
      const msg = [
        `<b>SIZE ${TARGET_SIZE} BACK IN STOCK</b>`,
        `${PRODUCT_NAME}`,
        ``,
        `Size: UK ${TARGET_SIZE}${lowNote}`,
        `Current price: £${info.currentPrice.toFixed(2)}${origNote}`,
        ``,
        `${URL}`,
      ].filter(Boolean).join('\n');
      const r = await tg(msg);
      if (r.ok) {
        state.stockAlertedAt = ts;
        console.log(`  -> Stock-return Telegram alert sent (UK ${TARGET_SIZE} ${sizeStatus})`);
      } else {
        console.error(`  -> Telegram failed: status=${r.status}`);
      }
    } else {
      console.log(`  -> size ${TARGET_SIZE} in stock but already alerted within 24h`);
    }
  }

  // PRICE-DROP ALERT: price <= target AND size still available (don't alert if your size is gone)
  if (priceHitsTarget && sizeInStock) {
    const priceAlertedRecent = state.alertedAt && (Date.now() - Date.parse(state.alertedAt)) < 24 * 3600 * 1000;
    if (!priceAlertedRecent) {
      const savedVs = info.originalPrice ? ` (£${(info.originalPrice - info.currentPrice).toFixed(2)} off RRP £${info.originalPrice.toFixed(2)})` : '';
      const msg = [
        `<b>PRICE DROP ALERT</b>`,
        `${PRODUCT_NAME} (UK ${TARGET_SIZE} in stock)`,
        ``,
        `Current: <b>£${info.currentPrice.toFixed(2)}</b>${savedVs}`,
        `Target: £${TARGET_PRICE.toFixed(2)}`,
        ``,
        `${URL}`,
      ].filter(Boolean).join('\n');
      const r = await tg(msg);
      if (r.ok) {
        state.alertedAt = ts;
        state.alertedAtPrice = info.currentPrice;
        console.log(`  -> Price-drop Telegram alert sent (£${info.currentPrice.toFixed(2)} <= target)`);
      } else {
        console.error(`  -> Telegram failed: status=${r.status}`);
      }
    } else {
      console.log(`  -> price at target but already alerted within 24h`);
    }
  } else {
    if (state.alertedAt && !priceHitsTarget) {
      console.log(`  -> price recovered above target; clearing price-alert flag`);
      state.alertedAt = null;
      state.alertedAtPrice = null;
    }
  }

  // Re-arm stock alert when size goes OOS again so a future return re-pings
  if (!sizeInStock && state.stockAlertedAt) {
    console.log(`  -> size ${TARGET_SIZE} back to OUT; clearing stock-alert flag for next return`);
    state.stockAlertedAt = null;
  }

  // Persist the snapshot for next-run delta detection
  state.lastSizeStatus_persisted = sizeInStock ? 'IN' : 'OUT';

  saveState(state);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
