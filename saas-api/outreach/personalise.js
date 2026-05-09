// Personalisation harness — Claude Code is the "worker."
//
// How it's used:
//   1. `node personalise.js list 20` → prints the next 20 leads that need
//      an intro_line, as JSON. Claude reads the list, then for each lead
//      uses WebSearch / WebFetch to learn one specific fact about that
//      business (a recent review theme, a speciality on their site, years
//      established, a city they highlight, etc.) and writes a single
//      sentence opener.
//   2. `node personalise.js set <lead_id> "<intro_line>"` → saves the
//      intro_line back to the store for that lead.
//
// The intro_line must:
//   - Be ONE sentence, under 25 words
//   - Reference something specific and real about their business
//   - Read like a human wrote it (no "I noticed that your website...")
//   - Not claim to be a customer or to have used their services
//
// Good examples:
//   "Saw you've been covering Croydon and South London for over a decade — that's a lot of boilers."
//   "Noticed the five-star streak on Google for emergency callouts."
//   "Your site mentions specialising in unvented cylinders, which is niche."
//
// Bad examples:
//   "I hope this email finds you well."   (generic)
//   "Love what you're doing at <name>."   (hollow)
//   "Your website is great!"              (no specificity)

const store = require('./leads-store');

function cmdList(limit) {
  const leads = store.listNeedingPersonalisation(limit);
  const shape = leads.map(l => ({
    id: l.id,
    business_name: l.business_name,
    city: l.city,
    website: l.website,
    rating: l.rating,
    review_count: l.review_count,
  }));
  console.log(JSON.stringify(shape, null, 2));
}

function cmdSet(id, line) {
  if (!id || !line) {
    console.error('Usage: personalise.js set <lead_id> "<intro_line>"');
    process.exit(1);
  }
  const trimmed = line.trim();
  if (trimmed.length < 10 || trimmed.length > 240) {
    console.error(`intro_line length ${trimmed.length} out of range (10-240)`);
    process.exit(1);
  }
  const updated = store.update(id, { intro_line: trimmed });
  if (!updated) {
    console.error(`Lead ${id} not found`);
    process.exit(1);
  }
  console.log(`OK ${id}: ${trimmed}`);
}

function cmdName(id, name) {
  if (!id || !name) {
    console.error('Usage: personalise.js name <lead_id> "<first_name>"');
    process.exit(1);
  }
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 40) {
    console.error(`first_name length ${trimmed.length} out of range (2-40)`);
    process.exit(1);
  }
  const updated = store.update(id, { first_name: trimmed });
  if (!updated) {
    console.error(`Lead ${id} not found`);
    process.exit(1);
  }
  console.log(`OK ${id}: first_name=${trimmed}`);
}

function cmdStats() {
  console.log(store.stats());
}

// =============================================================
// Auto-personalise: deterministic intro_line from existing data.
// Uses rating, review_count, city, and a single tagline scraped from
// the homepage (h1/meta-description/first-paragraph). Quality is
// lower than a hand-written intro but unblocks the pipeline when
// volume is the goal.
// =============================================================

async function fetchHomepage(url, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Automatyn/1.0)' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function stripTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractTagline(html) {
  // Try meta description, then h1, then first paragraph
  const metaDesc = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
  if (metaDesc) return metaDesc[1].trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const cleaned = stripTags(h1[1]);
    if (cleaned.length > 8 && cleaned.length < 200) return cleaned;
  }
  const p = html.match(/<p[^>]*>([\s\S]{40,300}?)<\/p>/i);
  if (p) {
    const cleaned = stripTags(p[1]);
    if (cleaned.length > 30) return cleaned.slice(0, 180);
  }
  return null;
}

const SPECIALITY_KEYWORDS = [
  ['boiler', 'boilers'],
  ['emergency', 'emergency callouts'],
  ['gas safe', 'Gas Safe work'],
  ['leak', 'leak repairs'],
  ['drain', 'drain unblocking'],
  ['cylinder', 'unvented cylinders'],
  ['underfloor', 'underfloor heating'],
  ['power flush', 'power flushing'],
  ['bathroom', 'bathroom installs'],
  ['heating', 'heating systems'],
  ['radiator', 'radiator work'],
  ['commercial', 'commercial plumbing'],
  ['landlord', 'landlord gas safety checks'],
  ['24/7', '24/7 callouts'],
  ['24 hour', '24 hour callouts'],
];

function extractSpeciality(text) {
  const lower = text.toLowerCase();
  for (const [needle, label] of SPECIALITY_KEYWORDS) {
    if (lower.includes(needle)) return label;
  }
  return null;
}

function buildIntroLine(lead, speciality) {
  const rating = lead.rating;
  const reviews = lead.review_count;
  const city = lead.city;
  // Tier 1: rating + reviews (strong proof point)
  if (rating && reviews && reviews >= 30) {
    if (speciality) {
      return `Saw the ${rating}-star streak across ${reviews}+ reviews and the ${speciality} focus.`;
    }
    return `Saw the ${rating}-star streak across ${reviews}+ Google reviews in ${city}.`;
  }
  // Tier 2: speciality only
  if (speciality) {
    return `Noticed your ${speciality} focus on the site.`;
  }
  // Tier 3: rating only
  if (rating && reviews) {
    return `Saw the ${rating}-star rating across ${reviews} Google reviews in ${city}.`;
  }
  // Tier 4: reviews only
  if (reviews && reviews >= 20) {
    return `Saw the ${reviews}+ Google reviews in ${city}.`;
  }
  // Tier 5: city only (weakest, last resort)
  if (city) {
    return `Saw your work covering ${city}.`;
  }
  return null;
}

async function cmdAuto(limit) {
  const leads = store.listNeedingPersonalisation(limit);
  console.log(`Auto-personalising ${leads.length} leads...`);
  let ok = 0, skip = 0;
  for (const lead of leads) {
    let speciality = null;
    if (lead.website) {
      const url = lead.website.startsWith('http') ? lead.website : 'https://' + lead.website;
      const html = await fetchHomepage(url);
      if (html) {
        const tagline = extractTagline(html);
        speciality = extractSpeciality((tagline || '') + ' ' + stripTags(html).slice(0, 4000));
      }
    }
    const intro = buildIntroLine(lead, speciality);
    if (!intro) { skip++; console.log(`  · ${lead.business_name} — no signal`); continue; }
    if (intro.length < 10 || intro.length > 240) { skip++; continue; }
    store.update(lead.id, { intro_line: intro });
    ok++;
    console.log(`  ✓ ${lead.business_name} → ${intro}`);
  }
  console.log(`Done. Personalised ${ok}, skipped ${skip}.`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') cmdList(parseInt(args[0], 10) || 20);
else if (cmd === 'set') cmdSet(args[0], args.slice(1).join(' '));
else if (cmd === 'name') cmdName(args[0], args.slice(1).join(' '));
else if (cmd === 'stats') cmdStats();
else if (cmd === 'auto') cmdAuto(parseInt(args[0], 10) || 20).catch(err => { console.error(err); process.exit(1); });
else {
  console.log('Commands:');
  console.log('  list [N]            — print next N leads needing intro_line as JSON');
  console.log('  auto [N]            — auto-write intro_line from rating/reviews/scraped tagline');
  console.log('  set <id> "<line>"   — save intro_line for lead (manual)');
  console.log('  name <id> "<name>"  — save scraped first_name for lead');
  console.log('  stats               — show store stats');
}
