// Scrape each unnamed lead's website for an owner/founder first name.
// Heuristic-only — writes first_name only when confident.
//
// Usage: node enrich-names.js [--apply]
//   dry-run by default; --apply writes to leads.json

const https = require('https');
const http = require('http');
const { URL } = require('url');
const store = require('./leads-store');

const APPLY = process.argv.includes('--apply');
const UA = 'Mozilla/5.0 (AutomatynLeadEnrich/1.0; +https://automatyn.co)';

const PATHS = ['', '/about', '/about-us', '/meet-the-team', '/team', '/contact', '/contact-us', '/our-story'];

const COMMON_NAMES = new Set([
  'john','james','david','michael','paul','mark','peter','andrew','steven','robert','richard','daniel','chris','christopher','matthew','simon','tom','thomas','nick','nicholas','sam','samuel','ben','benjamin','adam','alex','alexander','george','harry','henry','jack','joseph','joe','josh','joshua','liam','lewis','luke','oliver','oscar','ryan','sean','scott','stephen','terry','tim','timothy','will','william','anthony','tony','dan','jason','jeff','jeffrey','martin','gary','kevin','brian','craig','ian','greg','graham','philip','phil','patrick','pat','charlie','charles','edward','eddie','frank','jim','lee','neil','nigel','rob','roger','ross','russell','stuart','wayne','kris','sunny','minar','julian','omar','ali','ahmed','mohamed','mohammed','hassan','ibrahim','karim','sami','yusuf','raj','ravi','amit','vijay','deepak','sanjay','vinod','jay','dev','arjun','rohan','rahul','imran','faisal','hamza','adnan','bilal','kamil','tomasz','piotr','pawel','jakub','marcin','krzysztof','michal','lukasz','wojciech','mateusz'
]);

function fetch(url) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', headers: { 'User-Agent': UA, 'Accept': 'text/html' }, timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const next = new URL(res.headers.location, u).href;
          return fetch(next).then(resolve);
        } catch { return resolve(null); }
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 500000) { req.destroy(); resolve(data); } });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function extractName(text) {
  if (!text) return null;

  // Patterns in preferred order
  const patterns = [
    /(?:founder|owner|director|managing director|md|proprietor)[^a-z]{1,30}([A-Z][a-z]{2,15})\s+[A-Z][a-z]{2,20}/,
    /(?:my name is|i['' ]?m|hi,?\s*i['' ]?m|i am)\s+([A-Z][a-z]{2,15})/,
    /([A-Z][a-z]{2,15})\s+[A-Z][a-z]{2,20}[^a-zA-Z]{0,30}(?:founder|owner|director|proprietor)/,
    /hi[,.]?\s+i['' ]?m\s+([A-Z][a-z]{2,15})/i,
    /meet\s+([A-Z][a-z]{2,15})/,
    /run by\s+([A-Z][a-z]{2,15})/,
    /contact\s+([A-Z][a-z]{2,15})\s+on/i,
    /([A-Z][a-z]{2,15})\s+is\s+(?:the|our)\s+(?:founder|owner|director|md|proprietor)/i,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const candidate = m[1];
      if (COMMON_NAMES.has(candidate.toLowerCase())) return candidate;
    }
  }
  return null;
}

async function enrichLead(lead) {
  if (!lead.website) return null;
  const base = lead.website.replace(/\/+$/, '');
  for (const path of PATHS) {
    const url = base + path;
    const html = await fetch(url);
    if (!html) continue;
    const text = stripHtml(html);
    const name = extractName(text);
    if (name) return { name, source: url };
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function main() {
  const all = store.listAll();
  const targets = all.filter(l => l.email && l.intro_line && !l.email1_sent && !l.unsubscribed && !l.bounced && !l.first_name && l.website);
  console.log(`${APPLY ? 'APPLY' : 'DRY'} — scanning ${targets.length} leads`);

  let found = 0;
  for (const lead of targets) {
    process.stdout.write(`  ${lead.business_name}... `);
    try {
      const r = await enrichLead(lead);
      if (r) {
        console.log(`\x1b[32m${r.name}\x1b[0m  (${r.source})`);
        if (APPLY) store.update(lead.id, { first_name: r.name });
        found++;
      } else {
        console.log('no match');
      }
    } catch (err) {
      console.log('err:', err.message);
    }
  }
  console.log(`\n${found}/${targets.length} enriched${APPLY ? ' (applied)' : ' (dry-run, re-run with --apply)'}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
