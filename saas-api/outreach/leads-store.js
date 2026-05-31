// JSON-file-backed lead store for cold email outreach.
// Each lead:
// { id, business_name, website, phone, address, city, rating, review_count,
//   email, email_verified, intro_line,
//   email1_sent, email2_sent, email3_sent,
//   replied, unsubscribed, bounced,
//   status, created_at, updated_at }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const LOCK_FILE = path.join(DATA_DIR, 'leads.lock');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '{}');
}

function withLock(fn) {
  ensureDir();
  const start = Date.now();
  while (fs.existsSync(LOCK_FILE)) {
    if (Date.now() - start > 5000) throw new Error('leads-store: lock timeout');
    const waitMs = 50; const end = Date.now() + waitMs;
    while (Date.now() < end) { /* spin */ }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  try { return fn(); } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

function readAll() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeAll(obj) {
  const tmp = LEADS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, LEADS_FILE);
}

function makeId(business_name, city) {
  const seed = `${(business_name || '').toLowerCase()}|${(city || '').toLowerCase()}`;
  return 'lead_' + crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

function getById(id) {
  const all = readAll();
  return all[id] || null;
}

function findByEmail(email) {
  if (!email) return null;
  const all = readAll();
  const norm = email.trim().toLowerCase();
  for (const id of Object.keys(all)) {
    if ((all[id].email || '').toLowerCase() === norm) return all[id];
  }
  return null;
}

// Upsert a lead. Returns { id, created }.
function upsert(partial) {
  return withLock(() => {
    const all = readAll();
    const id = partial.id || makeId(partial.business_name, partial.city);
    const existing = all[id];
    const now = new Date().toISOString();
    if (existing) {
      all[id] = {
        ...existing,
        ...partial,
        id,
        updated_at: now,
      };
      writeAll(all);
      return { id, created: false };
    }
    all[id] = {
      id,
      business_name: partial.business_name || '',
      website: partial.website || '',
      phone: partial.phone || '',
      address: partial.address || '',
      city: partial.city || '',
      rating: partial.rating || null,
      review_count: partial.review_count || null,
      email: partial.email || '',
      email_verified: false,
      intro_line: '',
      email1_sent: null,
      email2_sent: null,
      email3_sent: null,
      replied: false,
      unsubscribed: false,
      bounced: false,
      status: 'new',
      created_at: now,
      updated_at: now,
      ...partial,
    };
    writeAll(all);
    return { id, created: true };
  });
}

function update(id, patch) {
  return withLock(() => {
    const all = readAll();
    if (!all[id]) return null;
    all[id] = { ...all[id], ...patch, id, updated_at: new Date().toISOString() };
    writeAll(all);
    return all[id];
  });
}

function listAll() {
  return Object.values(readAll());
}

// Leads needing email enrichment: has website but no email, not bounced/unsub.
function listNeedingEnrichment(limit = Infinity) {
  // Newest-first, and skip leads already attempted-and-failed (enrich_attempted).
  // Old behaviour sliced oldest-first and re-scraped 5-week-old dead leads every
  // run, wasting the batch on businesses that already proved emailless. Fresh
  // never-tried leads have a far higher hit rate.
  return listAll()
    .filter(l => !l.email && l.website && !l.bounced && !l.unsubscribed && !l.enrich_attempted)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, limit);
}

// Leads needing personalisation: has email, no intro_line, not bounced/unsub.
function listNeedingPersonalisation(limit = Infinity) {
  return listAll()
    .filter(l => l.email && !l.intro_line && !l.email1_sent && !l.bounced && !l.dns_flagged && !l.unsubscribed && !l.replied)
    .slice(0, limit);
}

// Leads ready for Email 1: email + intro_line + never emailed + clean.
function listReadyForEmail1(limit = Infinity) {
  return listAll()
    .filter(l => l.email && l.intro_line && !l.email1_sent && !l.bounced && !l.dns_flagged && !l.unsubscribed && !l.replied && !l.do_not_send)
    .slice(0, limit);
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

// Leads ready for Email 2: email1 sent 3+ days ago, email2 not sent, clean.
function listReadyForEmail2(limit = Infinity, minDays = 3) {
  return listAll()
    .filter(l => l.email1_sent && !l.email2_sent && !l.bounced && !l.dns_flagged && !l.unsubscribed && !l.replied && !l.do_not_send && daysSince(l.email1_sent) >= minDays)
    .slice(0, limit);
}

// Leads ready for Email 3: email1 sent 5+ days ago, email3 not sent, clean.
function listReadyForEmail3(limit = Infinity, minDays = 5) {
  return listAll()
    .filter(l => l.email1_sent && !l.email3_sent && !l.bounced && !l.dns_flagged && !l.unsubscribed && !l.replied && !l.do_not_send && daysSince(l.email1_sent) >= minDays)
    .slice(0, limit);
}

function stats() {
  const all = listAll();
  const todayIso = new Date().toISOString().slice(0, 10);
  const sentToday = (iso) => iso && iso.slice(0, 10) === todayIso;
  return {
    total: all.length,
    with_email: all.filter(l => l.email).length,
    personalised: all.filter(l => l.intro_line).length,
    email1_sent_total: all.filter(l => l.email1_sent).length,
    email2_sent_total: all.filter(l => l.email2_sent).length,
    email3_sent_total: all.filter(l => l.email3_sent).length,
    email1_sent_today: all.filter(l => sentToday(l.email1_sent)).length,
    email2_sent_today: all.filter(l => sentToday(l.email2_sent)).length,
    email3_sent_today: all.filter(l => sentToday(l.email3_sent)).length,
    replied_total: all.filter(l => l.replied).length,
    bounced_total: all.filter(l => l.bounced).length,
    unsubscribed_total: all.filter(l => l.unsubscribed).length,
    email1_opens: all.filter(l => l.email1_opened_at).length,
    email2_opens: all.filter(l => l.email2_opened_at).length,
    email3_opens: all.filter(l => l.email3_opened_at).length,
  };
}

module.exports = {
  upsert, update, getById, findByEmail, listAll,
  listNeedingEnrichment, listNeedingPersonalisation,
  listReadyForEmail1, listReadyForEmail2, listReadyForEmail3,
  stats,
};
