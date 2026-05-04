// Email enrichment — scrape websites for contact emails.
// For each lead with a website but no email:
//   1. Fetch homepage, extract mailto: links
//   2. If none, fetch common contact paths (/contact, /contact-us, /about)
//   3. Regex for plain-text emails as fallback
//   4. Filter obvious junk (sentry, wixpress, example.com, no-reply, etc.)
//   5. Prefer emails on the same root domain as the website
//   6. Save first good email back to the lead

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
];

const CONTACT_PATHS = ['/contact', '/contact-us', '/contacts', '/about', '/about-us', '/get-in-touch'];

function rootDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    const parts = u.hostname.replace(/^www\./, '').split('.');
    if (parts.length >= 2) return parts.slice(-2).join('.');
    return u.hostname;
  } catch { return null; }
}

function isJunkEmail(email) {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!local || !domain) return true;
  if (JUNK_DOMAINS.has(domain)) return true;
  for (const bad of JUNK_LOCAL_PARTS) {
    if (local.startsWith(bad)) return true;
  }
  // Filter image-like file extensions that the regex can eat
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico)$/i.test(email)) return true;
  // Filter obvious placeholders in the local part
  if (/^(test|admin|user|your|my)email?$/.test(local)) return true;
  return false;
}

function extractEmails(html) {
  const found = new Set();
  // mailto: links first (most reliable)
  const mailtoRe = /mailto:([^"'\s?>]+)/gi;
  let m;
  while ((m = mailtoRe.exec(html))) {
    const raw = decodeURIComponent(m[1]).trim();
    if (raw && raw.includes('@')) found.add(raw.toLowerCase());
  }
  // Plain-text emails
  const plainRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  while ((m = plainRe.exec(html))) {
    found.add(m[0].toLowerCase());
  }
  return [...found].filter(e => !isJunkEmail(e));
}

async function fetchText(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Automatyn/1.0)' },
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
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
  // Prefer info@/hello@/contact@ over generic personal emails on free providers
  const preferredLocal = ['info', 'hello', 'contact', 'enquiries', 'sales', 'office', 'admin'];
  for (const pref of preferredLocal) {
    const hit = emails.find(e => e.startsWith(pref + '@'));
    if (hit) return hit;
  }
  return emails[0];
}

async function enrichOne(lead) {
  if (!lead.website) return { ok: false, reason: 'no_website' };
  const base = lead.website.startsWith('http') ? lead.website : 'https://' + lead.website;
  const pages = [base, ...CONTACT_PATHS.map(p => {
    try { return new URL(p, base).toString(); } catch { return null; }
  }).filter(Boolean)];

  for (const page of pages) {
    const html = await fetchText(page);
    if (!html) continue;
    const emails = extractEmails(html);
    const pick = pickBestEmail(emails, base);
    if (pick) {
      store.update(lead.id, { email: pick });
      return { ok: true, email: pick, page };
    }
  }
  return { ok: false, reason: 'no_email_found' };
}

async function run(limit = 50) {
  const leads = store.listNeedingEnrichment(limit);
  console.log(`Enriching ${leads.length} leads...`);
  let found = 0, miss = 0;
  for (const lead of leads) {
    const r = await enrichOne(lead);
    if (r.ok) {
      found++;
      console.log(`  ✓ ${lead.business_name} → ${r.email}`);
    } else {
      miss++;
      console.log(`  · ${lead.business_name} — ${r.reason}`);
    }
  }
  console.log(`Done. Found ${found}, missed ${miss}.`);
  console.log(store.stats());
}

if (require.main === module) {
  const limit = parseInt(process.argv[2], 10) || 50;
  run(limit).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { enrichOne, extractEmails, pickBestEmail, isJunkEmail };
