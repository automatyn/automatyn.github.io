#!/usr/bin/env node
// Generic On.com UK shoe price + size watcher.
// Invoked per-product via env vars:
//   PRODUCT_URL=<full on.com/en-gb/products URL>
//   PRODUCT_NAME=<human-readable>
//   TARGET_PRICE=<GBP>
//   TARGET_SIZE=<UK size string e.g. "9">
//   STATE_FILE=<absolute path>
//
// Telegram alert on EITHER (a) target_size restock event OR (b) price <= target AND target_size in stock.
// One-shot per drop episode, re-arms on state change.

const fs = require('fs');
const https = require('https');
const http = require('http');
const WebSocket = require('/home/marketingpatpat/node_modules/ws');

const PRODUCT_URL = process.env.PRODUCT_URL;
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'On.com product';
const TARGET_PRICE = parseFloat(process.env.TARGET_PRICE || '95');
const TARGET_SIZE = process.env.TARGET_SIZE || '9';
const STATE_FILE = process.env.STATE_FILE;
const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';
const CDP = 'http://localhost:18800';

if (!PRODUCT_URL || !STATE_FILE) {
  console.error('FATAL: PRODUCT_URL and STATE_FILE env vars are required');
  process.exit(2);
}

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
  if (!fs.existsSync(STATE_FILE)) return { runs: 0 };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { runs: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function scrape() {
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
  await send('Page.navigate', { url: PRODUCT_URL });
  await new Promise(r => setTimeout(r, 11000));
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
          .find(b => /accept|agree|allow|got it|ok/i.test(b.innerText || b.value || ''));
        if (btn) btn.click();
      })()
    `,
    returnByValue: true,
  });
  await new Promise(r => setTimeout(r, 3000));

  const result = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const txt = document.body.innerText || '';
        const out = { finalUrl: location.href, redirected: !location.href.includes(${JSON.stringify(PRODUCT_URL.split('?')[0])}.split('/').slice(-1)[0]) };
        out.title = (document.querySelector('h1')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
        const cur = txt.match(/Current price[^£]{0,40}£\\s?([0-9]+(?:\\.[0-9]{1,2})?)/i);
        const orig = txt.match(/original price[^£]{0,40}£\\s?([0-9]+(?:\\.[0-9]{1,2})?)/i);
        if (cur) out.currentPrice = parseFloat(cur[1]);
        if (orig) out.originalPrice = parseFloat(orig[1]);
        if (out.currentPrice == null) {
          const m = txt.match(/£\\s?([0-9]+(?:\\.[0-9]{1,2})?)/);
          if (m) out.currentPrice = parseFloat(m[1]);
        }
        const sizeMap = {};
        const spans = Array.from(document.querySelectorAll('[class*="sizeValue"]'));
        for (const s of spans) {
          const lbl = (s.innerText || '').trim();
          if (!/^[0-9]+(\\.[0-9])?$/.test(lbl)) continue;
          let el = s; let d = 0;
          while (el && d < 6) { if (el.tagName === 'BUTTON') break; el = el.parentElement; d++; }
          const cls = el && typeof el.className === 'string' ? el.className : '';
          const bt = (el?.innerText || '').toLowerCase();
          const oos = /no items left|notify me|sold out|out of stock/i.test(bt) || /OutOfStock/i.test(cls);
          const low = bt.match(/only\\s+(\\d+)\\s+left/i);
          sizeMap[lbl] = oos ? 'OUT' : (low ? 'LOW:'+low[1] : 'IN');
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
  try { info = await scrape(); }
  catch (e) {
    console.error(`[${PRODUCT_NAME}] run ${state.runs} scrape failed:`, e.message);
    state.lastError = e.message;
    state.lastErrorAt = new Date().toISOString();
    saveState(state);
    process.exit(1);
  }

  // Detect dead product page (redirect to /shop or no sizes found)
  if (info.totalSizes === 0 || !info.title || /shop all|waiting room|404/i.test(info.title)) {
    console.log(`[${PRODUCT_NAME}] run ${state.runs} page-not-product (title="${info.title}" url=${info.finalUrl})`);
    state.lastPageDead = new Date().toISOString();
    state.lastCheckAt = new Date().toISOString();
    saveState(state);
    return;
  }

  const ts = new Date().toISOString();
  const sizeStatus = info.sizes?.[TARGET_SIZE] || 'NOT_FOUND';
  const origNote = info.originalPrice ? ` (RRP £${info.originalPrice.toFixed(2)})` : '';
  const priceStr = info.currentPrice != null ? `£${info.currentPrice.toFixed(2)}` : 'NO_PRICE';
  console.log(`[${PRODUCT_NAME}] run ${state.runs} ${ts} ${priceStr}${origNote} target=£${TARGET_PRICE.toFixed(2)} size${TARGET_SIZE}=${sizeStatus} inStock=[${info.inStockSizes?.join(',')}]`);
  state.lastPrice = info.currentPrice || null;
  state.lastOriginalPrice = info.originalPrice || null;
  state.lastTitle = info.title;
  state.lastCheckAt = ts;
  state.lastError = null;
  state.lastSizeStatus = sizeStatus;
  state.lastInStockSizes = info.inStockSizes || [];

  const sizeInStock = sizeStatus !== 'OUT' && sizeStatus !== 'NOT_FOUND';
  const priceHitsTarget = info.currentPrice != null && info.currentPrice <= TARGET_PRICE;

  // STOCK-RETURN ALERT
  if (sizeInStock && state.lastSizeStatus_persisted === 'OUT') {
    const recent = state.stockAlertedAt && (Date.now() - Date.parse(state.stockAlertedAt)) < 24 * 3600 * 1000;
    if (!recent) {
      const lowNote = sizeStatus.startsWith('LOW:') ? ` (only ${sizeStatus.replace('LOW:', '')} left, move fast)` : '';
      const msg = [
        `<b>SIZE ${TARGET_SIZE} BACK IN STOCK</b>`,
        `${PRODUCT_NAME}`,
        ``,
        `Size: UK ${TARGET_SIZE}${lowNote}`,
        info.currentPrice != null ? `Current price: £${info.currentPrice.toFixed(2)}${origNote}` : null,
        ``,
        `${PRODUCT_URL}`,
      ].filter(Boolean).join('\n');
      const r = await tg(msg);
      if (r.ok) { state.stockAlertedAt = ts; console.log(`  -> Stock alert sent`); }
      else console.error(`  -> Telegram failed: ${r.status}`);
    } else { console.log(`  -> in stock, already alerted within 24h`); }
  }

  // PRICE-DROP ALERT (only if size also available)
  if (priceHitsTarget && sizeInStock) {
    const recent = state.alertedAt && (Date.now() - Date.parse(state.alertedAt)) < 24 * 3600 * 1000;
    if (!recent) {
      const savedVs = info.originalPrice ? ` (£${(info.originalPrice - info.currentPrice).toFixed(2)} off RRP £${info.originalPrice.toFixed(2)})` : '';
      const msg = [
        `<b>PRICE DROP ALERT</b>`,
        `${PRODUCT_NAME} (UK ${TARGET_SIZE} in stock)`,
        ``,
        `Current: <b>£${info.currentPrice.toFixed(2)}</b>${savedVs}`,
        `Target: £${TARGET_PRICE.toFixed(2)}`,
        ``,
        `${PRODUCT_URL}`,
      ].filter(Boolean).join('\n');
      const r = await tg(msg);
      if (r.ok) { state.alertedAt = ts; state.alertedAtPrice = info.currentPrice; console.log(`  -> Price alert sent`); }
      else console.error(`  -> Telegram failed: ${r.status}`);
    } else { console.log(`  -> price at target, already alerted within 24h`); }
  } else if (state.alertedAt && !priceHitsTarget) {
    console.log(`  -> price recovered; clearing alert flag`);
    state.alertedAt = null;
    state.alertedAtPrice = null;
  }

  if (!sizeInStock && state.stockAlertedAt) {
    console.log(`  -> size went OOS again; clearing stock-alert flag`);
    state.stockAlertedAt = null;
  }

  state.lastSizeStatus_persisted = sizeInStock ? 'IN' : 'OUT';
  saveState(state);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
