#!/usr/bin/env node
// Amazon price watcher for B09D6J56NS via CDP 18800 (uses Pat's logged-in Chrome).
// Pings Telegram when price hits target. One-shot per drop episode.
//
// Usage: node amazon-price-watcher.js   (from systemd timer every 30 min)

const fs = require('fs');
const https = require('https');
const http = require('http');
const WebSocket = require('/home/marketingpatpat/node_modules/ws');

const ASIN = 'B09D6J56NS';
const URL = `https://www.amazon.co.uk/dp/${ASIN}/`;
const TARGET_PRICE = 70.00; // GBP
const TG_TOKEN = '8726414142:AAFQr-8dHxws5g9zZpu6IbjhmoN7b7lf8qc';
const TG_CHAT = '5904617085';
const STATE_FILE = '/home/marketingpatpat/openclaw/saas-api/amazon-price-state.json';
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
  // Pick any existing page tab to navigate (reuse Pat's Chrome session)
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

  // Navigate to product page
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await new Promise(r => setTimeout(r, 7000)); // wait for hydration

  // Auto-accept cookie banner if present (Amazon UK GDPR overlay blocks price area)
  await send('Runtime.evaluate', {
    expression: `
      (() => {
        const btn = document.querySelector('#sp-cc-accept, input[name="accept"], button[name="accept"]')
                 || Array.from(document.querySelectorAll('input,button')).find(el => /accept/i.test(el.value || el.innerText || ''));
        if (btn) { btn.click(); return 'clicked'; }
        return 'no-banner';
      })()
    `,
    returnByValue: true,
  });
  await new Promise(r => setTimeout(r, 3000)); // wait for price area to render after cookie dismissed

  // Extract price + title. Amazon UK may render the price in £ OR € depending
  // on the Chrome session's delivery location. We grab whatever currency
  // appears and convert to GBP downstream.
  const result = await send('Runtime.evaluate', {
    expression: `
      (() => {
        const title = (document.querySelector('#productTitle')?.innerText || '').trim().slice(0, 150);
        // Try the strongest selectors first — these always contain the main buy-box price
        const selectors = [
          '#corePriceDisplay_desktop_feature_div .a-offscreen',
          '#corePrice_feature_div .a-offscreen',
          '.priceToPay .a-offscreen',
          '.apexPriceToPay .a-offscreen',
          '#corePriceDisplay_desktop_feature_div .a-price-whole',
          '#corePrice_feature_div',
          '#apex_desktop .a-price',
          '.a-price[data-a-color="price"]',
          '#price_inside_buybox',
          '#newBuyBoxPrice',
        ];
        let priceText = null;
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          const tx = el?.innerText?.trim() || '';
          if (tx && /[£$€]|EUR|GBP|USD/i.test(tx)) { priceText = tx; break; }
        }
        const availability = (document.querySelector('#availability')?.innerText || '').trim().slice(0, 80);
        const blocked = !!document.querySelector('form[action*="validateCaptcha"]') || document.title.includes('Robot Check');
        return { title, priceText, availability, blocked, url: location.href };
      })()
    `,
    returnByValue: true,
  });
  ws.close();

  const r = result.result?.result?.value || {};
  if (r.blocked) throw new Error('Amazon CAPTCHA / robot check page');
  if (!r.priceText) return { ...r, priceGbp: null, priceRaw: null, currency: null };

  // Parse currency + amount. Handles "£99.99", "EUR 92.68", "EUR92.68", "$129.00".
  const txt = r.priceText.replace(/\s+/g, ' ');
  let currency = null, amount = null;
  let m;
  if ((m = txt.match(/£\s*([0-9,]+(?:\.[0-9]{1,2})?)/))) { currency = 'GBP'; amount = parseFloat(m[1].replace(/,/g, '')); }
  else if ((m = txt.match(/(?:EUR|€)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i))) { currency = 'EUR'; amount = parseFloat(m[1].replace(/,/g, '')); }
  else if ((m = txt.match(/(?:USD|\$)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i))) { currency = 'USD'; amount = parseFloat(m[1].replace(/,/g, '')); }

  if (amount == null) return { ...r, priceGbp: null, priceRaw: r.priceText, currency: null };

  // Convert to GBP. Cached daily FX rate to avoid hammering an exchange API.
  let priceGbp = amount;
  if (currency !== 'GBP') {
    const fx = await getFxRate(currency, 'GBP');
    if (fx == null) return { ...r, priceGbp: null, priceRaw: r.priceText, currency, amount, fxError: true };
    priceGbp = +(amount * fx).toFixed(2);
  }
  return { ...r, priceGbp, priceRaw: r.priceText, currency, amount };
}

// Daily-cached FX. Uses exchangerate.host (free, no key). Falls back to a hardcoded
// approximate rate if the API fails so the watcher doesn't break on network blip.
const FX_CACHE_FILE = '/home/marketingpatpat/openclaw/saas-api/.fx-cache.json';
const FX_FALLBACK = { 'EUR->GBP': 0.86, 'USD->GBP': 0.79 };
async function getFxRate(from, to) {
  const key = `${from}->${to}`;
  let cache = {};
  if (fs.existsSync(FX_CACHE_FILE)) {
    try { cache = JSON.parse(fs.readFileSync(FX_CACHE_FILE, 'utf8')); } catch {}
  }
  const today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.rates?.[key] != null) return cache.rates[key];
  // Fetch fresh
  const rate = await new Promise((resolve) => {
    https.get(`https://api.exchangerate.host/latest?base=${from}&symbols=${to}`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve(j?.rates?.[to] ?? null); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
  const useRate = rate != null ? rate : FX_FALLBACK[key];
  if (useRate == null) return null;
  cache = { date: today, rates: { ...(cache.rates || {}), [key]: useRate } };
  fs.writeFileSync(FX_CACHE_FILE, JSON.stringify(cache, null, 2));
  return useRate;
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

  if (info.priceGbp == null) {
    console.log(`[run ${state.runs}] no price extracted. raw="${info.priceText}" title="${info.title}"`);
    state.lastNoPrice = new Date().toISOString();
    saveState(state);
    return;
  }

  const ts = new Date().toISOString();
  const fxNote = info.currency && info.currency !== 'GBP' ? ` (from ${info.currency}${info.amount?.toFixed(2)})` : '';
  console.log(`[run ${state.runs}] ${ts} title="${info.title.slice(0,60)}" price=£${info.priceGbp.toFixed(2)}${fxNote} target=£${TARGET_PRICE.toFixed(2)}`);
  state.lastPrice = info.priceGbp;
  state.lastTitle = info.title;
  state.lastCheckAt = ts;
  state.lastError = null;

  // Hit target?
  if (info.priceGbp <= TARGET_PRICE) {
    const alreadyAlerted = state.alertedAt && (Date.now() - Date.parse(state.alertedAt)) < 24 * 3600 * 1000;
    if (!alreadyAlerted) {
      const fxLine = info.currency && info.currency !== 'GBP'
        ? `Listed in ${info.currency} ${info.amount?.toFixed(2)} - converted at today's FX rate`
        : '';
      const msg = [
        `<b>PRICE DROP ALERT</b>`,
        `${info.title}`,
        ``,
        `Current: <b>£${info.priceGbp.toFixed(2)}</b>`,
        `Target: £${TARGET_PRICE.toFixed(2)}`,
        fxLine,
        info.availability ? `Stock: ${info.availability}` : '',
        ``,
        `${URL}`,
      ].filter(Boolean).join('\n');
      const r = await tg(msg);
      if (r.ok) {
        state.alertedAt = ts;
        state.alertedAtPrice = info.priceGbp;
        console.log(`  → Telegram alert sent (£${info.priceGbp.toFixed(2)} ≤ target)`);
      } else {
        console.error(`  → Telegram failed: status=${r.status}`);
      }
    } else {
      console.log(`  → at/below target but already alerted within 24h (at £${state.alertedAtPrice})`);
    }
  } else {
    // Price went back above target — clear the alerted flag so a future drop re-pings
    if (state.alertedAt) {
      console.log(`  → price recovered above target; clearing alert flag`);
      state.alertedAt = null;
      state.alertedAtPrice = null;
    }
  }

  saveState(state);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
