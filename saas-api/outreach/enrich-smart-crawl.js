#!/usr/bin/env node
// Smart website crawler for email enrichment.
// For each lead with a website but no email:
//   1. Fetch homepage + obvious contact paths (/contact, /about, /team)
//   2. If still no personal email, ask gpt-4o-mini to look at the page text
//      and either (a) extract a hidden/obfuscated email, or (b) suggest the
//      next URL on the site most likely to contain owner contact info.
//   3. Follow that URL, repeat once.
//   4. Save the best email; flag role-only as DNS.
//
// Free pieces: lead websites you already own (Google Places ingest).
// Paid piece: gpt-4o-mini ~$0.0003/lead.

const fs = require('fs');
const path = require('path');
const store = require('./leads-store');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
const LIMIT = parseInt(process.argv[2] || '20', 10);
const VERTICAL_FILTER = process.argv[3] || null; // optional: filter by source_vertical

const ROLE_RE = /^(info|contact|admin|hello|enquiries|enquiry|sales|office|reception|reservations|booking|bookings|support|help|mail|email|noreply|no-reply|hr|jobs|careers|accounts|billing|finance|press|media|marketing|service|services|customerservice|customercare|team|webmaster|postmaster)@/i;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CONTACT_HINTS = ['contact', 'about', 'team', 'meet', 'staff', 'who-we-are', 'our-team', 'people', 'owner', 'founder', 'directors'];

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
    return await r.text();
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

function stripHTML(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function deobfuscate(text) {
  if (!text) return '';
  return text
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.');
}

function extractEmails(html, websiteDomain) {
  if (!html) return [];
  // mailto:
  const mailtoRe = /mailto:([^"'\s>?&]+)/gi;
  // plain email
  const plainRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  // obfuscated
  const deob = deobfuscate(html);
  const all = new Set();
  for (const m of (html.match(mailtoRe) || [])) all.add(m.replace(/^mailto:/, '').split('?')[0].toLowerCase());
  for (const m of (html.match(plainRe) || [])) all.add(m.toLowerCase());
  for (const m of (deob.match(plainRe) || [])) all.add(m.toLowerCase());
  return [...all].filter(e => {
    if (e.length > 80) return false;
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e)) return false;
    if (/example\.|test\.|domain\.|yoursite|sentry\.io|wixpress|cloudflare/i.test(e)) return false;
    return true;
  });
}

function pickBestEmail(emails, websiteDomain) {
  if (emails.length === 0) return null;
  // Prefer same-domain personal, then any personal, then same-domain role, then any role
  const sameDomain = (e) => websiteDomain && e.endsWith('@' + websiteDomain);
  const personal = (e) => !ROLE_RE.test(e);
  const ranked = emails.slice().sort((a, b) => {
    const score = (e) => (sameDomain(e) ? 2 : 0) + (personal(e) ? 1 : 0);
    return score(b) - score(a);
  });
  return ranked[0];
}

function rootDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch { return null; }
}

function absoluteUrl(href, base) {
  try { return new URL(href, base).toString(); }
  catch { return null; }
}

function extractLinks(html, base) {
  if (!html) return [];
  const re = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const out = [];
  const baseHost = rootDomain(base);
  for (const m of html.matchAll(re)) {
    const url = absoluteUrl(m[1], base);
    if (!url) continue;
    if (rootDomain(url) !== baseHost) continue;
    const text = m[2].replace(/<[^>]+>/g, '').trim().slice(0, 80);
    out.push({ url, text });
  }
  return out;
}

function pickContactLinks(links) {
  return links
    .map(l => ({ ...l, score: CONTACT_HINTS.reduce((s, h) => s + (new RegExp(h, 'i').test(l.url + ' ' + l.text) ? 1 : 0), 0) }))
    .filter(l => l.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function llmExtractFromPage(lead, pageText) {
  const sys = 'You analyse a UK small-business webpage and extract the most likely owner/director email. Prefer named personal emails (firstname@..., name@...) over role emails (info@, contact@). If multiple emails appear, pick the most senior-looking. Return JSON only.';
  const usr = `Business: ${lead.business_name || lead.businessName || ''}
Website: ${lead.website || ''}

Page text (truncated):
${pageText.slice(0, 8000)}

Return ONLY this JSON:
{"email": "<best email or null>", "owner_name": "<name or null>", "owner_title": "<title or null>", "confidence": "high|medium|low"}`;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 200,
    }),
  });
  if (!r.ok) return { email: null, error: `OpenAI ${r.status}` };
  const j = await r.json();
  try { return JSON.parse(j?.choices?.[0]?.message?.content); }
  catch { return { email: null, error: 'parse_fail' }; }
}

async function enrichLead(lead) {
  if (!lead.website) return { status: 'no_website' };
  const base = lead.website.startsWith('http') ? lead.website : 'https://' + lead.website;
  const domain = rootDomain(base);
  const tried = new Set();
  const collected = new Set();

  async function tryUrl(url) {
    if (tried.has(url)) return [];
    tried.add(url);
    const html = await fetchText(url);
    if (!html) return [];
    const emails = extractEmails(html, domain);
    for (const e of emails) collected.add(e);
    return emails;
  }

  // 1. Homepage
  await tryUrl(base);

  // 2. Obvious contact paths
  for (const p of ['/contact', '/contact-us', '/about', '/about-us', '/team', '/our-team', '/staff', '/meet-the-team']) {
    if (collected.size > 0 && [...collected].some(e => !ROLE_RE.test(e))) break;
    await tryUrl(base.replace(/\/$/, '') + p);
  }

  // 3. Best email so far?
  let best = pickBestEmail([...collected], domain);
  if (best && !ROLE_RE.test(best)) {
    return { status: 'found_personal', email: best, confidence: 'high', source: 'static-crawl' };
  }

  // 4. Smart-crawl: read homepage links, ask LLM nothing, pick contact-ish links via heuristic
  const homeHtml = await fetchText(base);
  const links = extractLinks(homeHtml || '', base);
  const candidates = pickContactLinks(links);
  for (const c of candidates.slice(0, 3)) {
    if ([...collected].some(e => !ROLE_RE.test(e))) break;
    await tryUrl(c.url);
  }

  best = pickBestEmail([...collected], domain);
  if (best && !ROLE_RE.test(best)) {
    return { status: 'found_personal_smart', email: best, confidence: 'high', source: 'heuristic-crawl' };
  }

  // 5. LLM extract on combined text from /contact (if any) + homepage
  const combinedText = [];
  for (const url of tried) {
    const h = await fetchText(url, 8000); // re-fetch is wasteful but kept simple
    if (h) combinedText.push(stripHTML(h));
    if (combinedText.length >= 3) break;
  }
  if (combinedText.length > 0) {
    const llm = await llmExtractFromPage(lead, combinedText.join('\n\n').slice(0, 12000));
    if (llm.email && llm.email !== 'null') {
      const llmPersonal = !ROLE_RE.test(llm.email);
      if (llmPersonal) return { status: 'found_via_llm', email: llm.email, confidence: llm.confidence || 'medium', source: 'llm-extract', owner: llm.owner_name, title: llm.owner_title };
    }
  }

  // 6. Role-only fallback
  if (best) return { status: 'role_only', email: best, confidence: 'low', source: 'role-fallback' };

  return { status: 'no_email_found' };
}

async function run() {
  const all = store.listAll();
  let pool = all.filter(l => l.website && !l.email && !l.do_not_send);
  if (VERTICAL_FILTER) pool = pool.filter(l => l.source_vertical === VERTICAL_FILTER);
  const targets = pool.slice(0, LIMIT);
  console.log(`Smart-crawl enriching ${targets.length} leads (cap ${LIMIT}, vertical=${VERTICAL_FILTER || 'any'}).`);
  let found = 0, roleOnly = 0, none = 0, errors = 0;
  for (const lead of targets) {
    const business = lead.business_name || lead.businessName;
    process.stdout.write(`· ${business}: `);
    try {
      const result = await enrichLead(lead);
      if (result.email && result.confidence !== 'low') {
        store.update(lead.id, { email: result.email, email_added_at: new Date().toISOString(), email_source: result.source, email_confidence: result.confidence });
        found++;
        console.log(`✓ ${result.email} (${result.confidence}, ${result.status})`);
      } else if (result.email) {
        store.update(lead.id, { email: result.email, email_added_at: new Date().toISOString(), email_source: result.source, email_confidence: 'low', do_not_send: true, do_not_send_reason: 'role-based or low-confidence' });
        roleOnly++;
        console.log(`~ ${result.email} (low, flagged DNS)`);
      } else {
        none++;
        console.log(result.status);
      }
    } catch (e) {
      errors++;
      console.log(`ERR: ${e.message}`);
    }
  }
  console.log(`\nDone. Found: ${found}, role-only DNS: ${roleOnly}, no-email: ${none}, errors: ${errors}`);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
