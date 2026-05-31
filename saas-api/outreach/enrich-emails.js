// Email enrichment — aggressive scrape for contact emails.
// Strategy (in order, stop on first hit):
//   1. Static fetch homepage + common contact paths, extract mailto: + plaintext + obfuscated
//   2. Static fetch sitemap.xml, find /contact-style URLs, scrape them
//   3. Yell.com lookup by business_name + city → scrape listing's contact section
//   4. Playwright (JS render) homepage + contact pages — for sites that hide email behind JS
// Filter junk (sentry, no-reply, tracking-pixel hashes, etc.) and prefer on-domain + role-mailbox emails.

const store = require('./leads-store');

const JUNK_DOMAINS = new Set([
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'example.com',
  'example.co.uk', 'domain.com', 'yourdomain.com', 'email.com',
  'sentry.wixpress.com', 'wix.com', 'squarespace.com',
  'mysite.com', 'yoursite.com', 'test.com', 'test.co.uk',
  'sample.com', 'placeholder.com',
]);

const JUNK_LOCAL_PARTS = [
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'postmaster', 'mailer-daemon', 'abuse',
  // Template/placeholder local-parts seen in scraped sites that bounce 100%:
  'you', 'youremail', 'your-email', 'youraddress',
  'name', 'firstname', 'lastname', 'fullname',
  'me', 'someone', 'somebody', 'demo', 'example',
  // Server-only mailboxes that don't accept human email:
  'server', 'webmaster', 'root', 'daemon', 'cron', 'system',
  'noc', 'nobody', 'mail', 'webhook',
];

const CONTACT_PATHS = [
  '/contact', '/contact-us', '/contacts', '/about', '/about-us',
  '/get-in-touch', '/contact.html', '/contact-us.html', '/about.html',
  '/enquiries', '/enquiry', '/quote', '/get-a-quote',
];

function rootDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    const parts = u.hostname.replace(/^www\./, '').split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
    return u.hostname;
  } catch { return null; }
}

const JUNK_LOCAL_SET = new Set(JUNK_LOCAL_PARTS);

function isJunkEmail(email) {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!local || !domain) return true;
  if (JUNK_DOMAINS.has(domain)) return true;
  if (JUNK_LOCAL_SET.has(local)) return true;
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(email)) return true;
  if (/^(test|admin|user|your|my)email?$/.test(local)) return true;
  if (/^[a-f0-9]{20,}$/i.test(local)) return true;
  if (/^[a-f0-9]{8,}@(o\d+\.ingest\.|sentry)/i.test(lower)) return true;
  if (/sentry/i.test(domain)) return true;
  return false;
}

// Decode common obfuscation patterns into clean emails.
// Examples handled:
//   "info [at] domain.co.uk"        → info@domain.co.uk
//   "info(at)domain.co.uk"          → info@domain.co.uk
//   "info AT domain DOT co DOT uk"  → info@domain.co.uk
//   "info&#64;domain.co.uk"         → info@domain.co.uk (HTML entity)
//   "info&#x40;domain.co.uk"        → info@domain.co.uk
function deobfuscate(text) {
  let s = text;
  // HTML entities first
  s = s.replace(/&#64;/g, '@').replace(/&#x40;/gi, '@');
  s = s.replace(/&#46;/g, '.').replace(/&#x2e;/gi, '.');
  // [at] / (at) / { at } / spaces around AT
  s = s.replace(/\s*[\[\(\{]\s*at\s*[\]\)\}]\s*/gi, '@');
  s = s.replace(/\s+at\s+/gi, '@');
  s = s.replace(/\s*\bAT\b\s*/g, '@');
  // [dot] / (dot) / DOT
  s = s.replace(/\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*/gi, '.');
  s = s.replace(/\s+dot\s+/gi, '.');
  s = s.replace(/\s*\bDOT\b\s*/g, '.');
  return s;
}

function extractEmails(html) {
  const found = new Set();
  // mailto: links — most reliable
  const mailtoRe = /mailto:([^"'\s?>]+)/gi;
  let m;
  while ((m = mailtoRe.exec(html))) {
    const raw = decodeURIComponent(m[1]).trim();
    if (raw && raw.includes('@')) found.add(raw.toLowerCase());
  }
  // Plain-text emails on the original HTML
  const plainRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  while ((m = plainRe.exec(html))) {
    found.add(m[0].toLowerCase());
  }
  // Plain-text emails AFTER deobfuscation
  const deob = deobfuscate(html);
  while ((m = plainRe.exec(deob))) {
    found.add(m[0].toLowerCase());
  }
  // Reset regex state (RegExp objects with /g hold lastIndex)
  plainRe.lastIndex = 0;
  return [...found].filter(e => !isJunkEmail(e));
}

async function fetchText(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text') && !ct.includes('xml')) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function pickBestEmail(emails, websiteUrl) {
  if (!emails.length) return null;
  const root = rootDomain(websiteUrl);
  if (root) {
    const onDomain = emails.find(e => e.split('@')[1] === root || e.split('@')[1].endsWith('.' + root));
    if (onDomain) return onDomain;
  }
  const preferredLocal = ['info', 'hello', 'contact', 'enquiries', 'sales', 'office', 'admin', 'support', 'bookings'];
  for (const pref of preferredLocal) {
    const hit = emails.find(e => e.startsWith(pref + '@'));
    if (hit) return hit;
  }
  return emails[0];
}

// Try to discover contact-style URLs from sitemap.xml
async function findContactUrlsFromSitemap(base) {
  const sitemapCandidates = [
    new URL('/sitemap.xml', base).toString(),
    new URL('/sitemap_index.xml', base).toString(),
    new URL('/wp-sitemap.xml', base).toString(),
  ];
  const found = [];
  for (const sm of sitemapCandidates) {
    const xml = await fetchText(sm, 10000);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1]);
    for (const loc of locs) {
      if (/contact|about|enquir|quote|get-in-touch/i.test(loc)) found.push(loc);
    }
    if (found.length) break;
  }
  return found.slice(0, 10);
}

// Yell.com fallback: search business_name + city, scrape first matching listing.
async function tryYell(businessName, city) {
  if (!businessName) return [];
  try {
    const q = encodeURIComponent(businessName);
    const loc = encodeURIComponent(city || 'United Kingdom');
    const url = `https://www.yell.com/ucs/UcsSearchAction.do?keywords=${q}&location=${loc}`;
    const html = await fetchText(url, 12000);
    if (!html) return [];
    return extractEmails(html);
  } catch { return []; }
}

// Playwright fallback for JS-rendered sites.
// Reuses one browser for the whole run, closes on exit / SIGTERM / SIGINT
// so we don't leak chromium processes if the run is interrupted.
let _playwright = null;
let _sharedBrowser = null;
async function getPlaywright() {
  if (_playwright === null) {
    try { _playwright = require('playwright'); }
    catch { _playwright = false; }
  }
  return _playwright;
}

async function getSharedBrowser() {
  if (_sharedBrowser) return _sharedBrowser;
  const pw = await getPlaywright();
  if (!pw) return null;
  _sharedBrowser = await pw.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return _sharedBrowser;
}

async function closeSharedBrowser() {
  if (_sharedBrowser) {
    try { await _sharedBrowser.close(); } catch {}
    _sharedBrowser = null;
  }
}

// Ensure cleanup on any exit path
process.once('exit', () => { /* sync only — best-effort */ });
process.once('SIGINT', async () => { await closeSharedBrowser(); process.exit(130); });
process.once('SIGTERM', async () => { await closeSharedBrowser(); process.exit(143); });

async function fetchRendered(url, timeoutMs = 20000) {
  const browser = await getSharedBrowser();
  if (!browser) return null;
  let ctx, page;
  try {
    ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });
    page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(1200);
    const html = await page.content();
    return html;
  } catch { return null; }
  finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function enrichOne(lead, opts = {}) {
  const { tryRender = true, tryYellFallback = true } = opts;
  if (!lead.website) return { ok: false, reason: 'no_website' };
  const base = lead.website.startsWith('http') ? lead.website : 'https://' + lead.website;

  // Tier 1: static fetch homepage + common contact paths
  const staticPages = [base, ...CONTACT_PATHS.map(p => {
    try { return new URL(p, base).toString(); } catch { return null; }
  }).filter(Boolean)];

  for (const page of staticPages) {
    const html = await fetchText(page);
    if (!html) continue;
    const emails = extractEmails(html);
    const pick = pickBestEmail(emails, base);
    if (pick) {
      store.update(lead.id, { email: pick, email_source: 'static:' + page });
      return { ok: true, email: pick, page, tier: 'static' };
    }
  }

  // Tier 2: sitemap-discovered contact pages
  const sitemapPages = await findContactUrlsFromSitemap(base);
  for (const page of sitemapPages) {
    const html = await fetchText(page);
    if (!html) continue;
    const emails = extractEmails(html);
    const pick = pickBestEmail(emails, base);
    if (pick) {
      store.update(lead.id, { email: pick, email_source: 'sitemap:' + page });
      return { ok: true, email: pick, page, tier: 'sitemap' };
    }
  }

  // Tier 3: Playwright (JS-rendered) homepage + best 2 contact paths
  if (tryRender) {
    const renderTargets = [base, new URL('/contact', base).toString(), new URL('/contact-us', base).toString()];
    for (const page of renderTargets) {
      const html = await fetchRendered(page);
      if (!html) continue;
      const emails = extractEmails(html);
      const pick = pickBestEmail(emails, base);
      if (pick) {
        store.update(lead.id, { email: pick, email_source: 'rendered:' + page });
        return { ok: true, email: pick, page, tier: 'rendered' };
      }
    }
  }

  // Tier 4: Yell.com fallback
  if (tryYellFallback && lead.business_name) {
    const emails = await tryYell(lead.business_name, lead.city);
    const pick = pickBestEmail(emails, base);
    if (pick) {
      store.update(lead.id, { email: pick, email_source: 'yell' });
      return { ok: true, email: pick, page: 'yell', tier: 'yell' };
    }
  }

  // Stamp the miss so listNeedingEnrichment skips this lead next run (stops the
  // queue re-grinding the same emailless sites every batch).
  store.update(lead.id, { enrich_attempted: new Date().toISOString() });
  return { ok: false, reason: 'no_email_found' };
}

async function run(limit = 50, opts = {}) {
  const leads = store.listNeedingEnrichment(limit);
  console.log(`Enriching ${leads.length} leads...`);
  let found = 0, miss = 0;
  const tierCounts = { static: 0, sitemap: 0, rendered: 0, yell: 0 };
  for (const lead of leads) {
    const r = await enrichOne(lead, opts);
    if (r.ok) {
      found++;
      tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
      console.log(`  ✓ [${r.tier}] ${lead.business_name} → ${r.email}`);
    } else {
      miss++;
      console.log(`  · ${lead.business_name} — ${r.reason}`);
    }
  }
  console.log(`Done. Found ${found}, missed ${miss}.`);
  console.log('Tier breakdown:', tierCounts);
  console.log(store.stats());
  await closeSharedBrowser();
}

if (require.main === module) {
  const limit = parseInt(process.argv[2], 10) || 50;
  // --no-render to skip Playwright (faster), --no-yell to skip Yell fallback
  const opts = {
    tryRender: !process.argv.includes('--no-render'),
    tryYellFallback: !process.argv.includes('--no-yell'),
  };
  run(limit, opts).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { enrichOne, extractEmails, pickBestEmail, isJunkEmail, deobfuscate };
