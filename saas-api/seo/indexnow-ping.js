#!/usr/bin/env node
// Submit a URL (or all sitemap URLs) to IndexNow for instant Bing/Yandex/DuckDuckGo crawl.
// Usage:
//   node indexnow-ping.js <url1> [url2] ...    # ping specific URLs
//   node indexnow-ping.js --sitemap            # ping all URLs in sitemap.xml (excluding noindex'd)

const fs = require('fs');
const https = require('https');
const path = require('path');

const KEY_FILE = path.join(__dirname, '..', 'secrets', 'indexnow-key.txt');
const SITEMAP_PATH = '/home/marketingpatpat/openclaw/sitemap.xml';
const HOST = 'automatyn.co';

const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();

// Pages flipped back to index 2026-05-16: passive-income, how-much-does-ai-chatbot-cost
const NOINDEX_URLS = new Set([
  'https://automatyn.co/blog/can-you-really-make-money-with-ai-2026.html',
  'https://automatyn.co/blog/claude-managed-agents-vs-openclaw-2026.html',
  'https://automatyn.co/blog/claude-managed-agents-what-it-means-2026.html',
  'https://automatyn.co/blog/claude-code-getting-dumber-2026.html',
  'https://automatyn.co/blog/claude-code-vs-codex-2026.html',
]);

let urls;
const args = process.argv.slice(2);
if (args.includes('--sitemap')) {
  const sm = fs.readFileSync(SITEMAP_PATH, 'utf8');
  urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1])
    .filter(u => !NOINDEX_URLS.has(u));
  console.log(`pinging ${urls.length} sitemap URLs (filtered ${NOINDEX_URLS.size} noindex)`);
} else {
  urls = args.filter(a => a.startsWith('http'));
  if (urls.length === 0) {
    console.error('Usage: indexnow-ping.js <url1> [url2] ...   OR   indexnow-ping.js --sitemap');
    process.exit(1);
  }
  console.log(`pinging ${urls.length} URL(s)`);
}

const body = JSON.stringify({
  host: HOST,
  key: KEY,
  keyLocation: 'https://' + HOST + '/' + KEY + '.txt',
  urlList: urls,
});

const req = https.request({
  hostname: 'api.indexnow.org',
  path: '/indexnow',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  },
}, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    if (res.statusCode === 200 || res.statusCode === 202) {
      console.log(`✓ IndexNow accepted (${res.statusCode})`);
    } else {
      console.log(`✗ IndexNow ${res.statusCode}: ${d.slice(0, 300)}`);
      process.exit(1);
    }
  });
});
req.on('error', e => { console.error('FAIL:', e.message); process.exit(1); });
req.write(body);
req.end();
