#!/usr/bin/env node
// Email enrichment via DuckDuckGo HTML scraping + OpenAI extraction.
// Mirrors the n8n "GET Persons Intro" workflow (SerpAPI+Gemini) but free.
//
// Pipeline per lead:
//   1. DuckDuckGo HTML search: `"<business>" "<city>" email`
//   2. Pull top 5 result snippets + URLs
//   3. Optionally fetch first 2 result pages (HTML, no Playwright)
//   4. Feed combined text to gpt-4o-mini, ask for owner email JSON
//   5. Validate + write to lead store (intro stays NULL — separate step)
//
// Usage:
//   OPENAI_API_KEY=sk-... node enrich-via-search.js [limit]
//
// Cost: ~$0.0003/lead (gpt-4o-mini, ~2k tokens in+out per call).

const fs = require('fs');
const path = require('path');
const store = require('./leads-store');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
const LIMIT = parseInt(process.argv[2] || '20', 10);

const ROLE_RE = /^(info|contact|admin|hello|enquiries|enquiry|sales|office|reception|reservations|booking|bookings|support|help|mail|email|noreply|no-reply|hr|jobs|careers|accounts|billing|finance|press|media|marketing|service|services|customerservice|customercare|team|webmaster|postmaster)@/i;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    return await r.text();
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}

// DuckDuckGo HTML endpoint (no JS required, no auth)
async function ddgSearch(query, max = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, 12000);
  if (!html) return [];
  const results = [];
  // DDG HTML results: <a class="result__a" href="...">title</a> then <a class="result__snippet">snippet</a>
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [...html.matchAll(linkRe)].map(m => ({ url: decodeURIComponent(m[1].replace(/^\/l\/\?uddg=/, '').split('&rut=')[0]), title: m[2].replace(/<[^>]+>/g, '').trim() }));
  const snips = [...html.matchAll(snipRe)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  for (let i = 0; i < Math.min(links.length, max); i++) {
    results.push({ url: links[i].url, title: links[i].title, snippet: snips[i] || '' });
  }
  return results;
}

function extractEmailsFromText(text) {
  if (!text) return [];
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const out = new Set();
  for (const m of (text.match(re) || [])) {
    if (m.length < 60) out.add(m.toLowerCase());
  }
  return [...out];
}

async function llmExtract(lead, searchResults, pageTexts) {
  const sys = `You are a research agent. You receive a UK small-business and a bundle of search results. Return JSON ONLY with the most likely owner/director email. Prefer named personal emails (firstname@..., name@...) over role emails (info@, contact@). If you only see a role email, return it but mark confidence "low". If no email found, return email=null.`;
  const usr = `Business: ${lead.business_name || ''}
City: ${lead.city || ''}
Website: ${lead.website || ''}
Industry: ${lead.industry || lead.category || ''}

DuckDuckGo results:
${searchResults.map((r,i) => `[${i+1}] ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n')}

Page contents (truncated):
${pageTexts.map((p,i) => `--- page ${i+1} (${p.url}) ---\n${p.text.slice(0, 4000)}`).join('\n\n')}

Return ONLY this JSON:
{"email": "<best email or null>", "owner_name": "<name or null>", "owner_title": "<title or null>", "confidence": "high|medium|low", "source_url": "<url where you saw the email or null>"}`;

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 300,
    }),
  });
  if (!r.ok) {
    const errText = await r.text();
    return { email: null, error: `OpenAI ${r.status}: ${errText.slice(0,150)}` };
  }
  const j = await r.json();
  const txt = j?.choices?.[0]?.message?.content;
  try { return JSON.parse(txt); }
  catch { return { email: null, error: 'parse_fail', raw: txt?.slice(0,200) }; }
}

async function enrichLead(lead) {
  const business = lead.business_name || lead.businessName;
  const city = lead.city || '';
  if (!business) return { status: 'no_business_name' };

  // Pass 1: search-only
  const q1 = `"${business}" ${city} email owner contact`;
  const results = await ddgSearch(q1, 5);
  if (results.length === 0) return { status: 'no_search_results' };

  // Quick regex pass over snippets first (cheap)
  const snipEmails = extractEmailsFromText(results.map(r => r.snippet).join(' '));
  const goodSnipEmail = snipEmails.find(e => !ROLE_RE.test(e));
  if (goodSnipEmail) return { status: 'found_in_snippet', email: goodSnipEmail, confidence: 'medium', source: 'ddg-snippet' };

  // Pass 2: fetch top 2 pages (skip social/listing-only domains)
  const pages = [];
  for (const r of results.slice(0, 2)) {
    if (/facebook\.com|linkedin\.com|instagram\.com|twitter\.com|x\.com|yell\.com/i.test(r.url)) continue;
    const text = await fetchText(r.url, 10000);
    if (text) {
      // Strip HTML tags for LLM context
      const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      pages.push({ url: r.url, text: stripped });
    }
  }

  // Try regex on fetched pages
  const pageEmails = extractEmailsFromText(pages.map(p => p.text).join(' '));
  const goodPageEmail = pageEmails.find(e => !ROLE_RE.test(e));
  if (goodPageEmail) return { status: 'found_in_page', email: goodPageEmail, confidence: 'high', source: 'page-regex' };

  // Pass 3: LLM extract (when regex misses obfuscated / contextual emails)
  const llm = await llmExtract(lead, results, pages);
  if (llm.email && llm.email !== 'null') {
    return { status: 'found_via_llm', email: llm.email, confidence: llm.confidence, source: llm.source_url, owner: llm.owner_name, title: llm.owner_title };
  }

  // Fall back: any role-based we found
  const anySnipEmail = snipEmails[0];
  const anyPageEmail = pageEmails[0];
  const fallback = anyPageEmail || anySnipEmail;
  if (fallback) return { status: 'role_only', email: fallback, confidence: 'low', source: 'fallback' };

  return { status: 'no_email_found' };
}

async function run() {
  const all = store.listAll();
  // Filter: has business_name, no email yet, not DNS, has website OR has city (we can still search)
  const targets = all.filter(l => (l.business_name || l.businessName) && !l.email && !l.do_not_send).slice(0, LIMIT);
  console.log(`Enriching ${targets.length} leads (cap ${LIMIT}).`);
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
        // Role-only — store but DNS-flag so it never sends
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
    // small delay so we don't get DDG-rate-limited
    await new Promise(r => setTimeout(r, 1200));
  }
  console.log(`\nDone. Found: ${found}, role-only (DNS-flagged): ${roleOnly}, no-email: ${none}, errors: ${errors}`);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
