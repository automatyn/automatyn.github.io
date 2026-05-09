// Ingest leads from Google Places API. Verticals + cities are parameterised.
//
// Usage:
//   node ingest.js                        # default: plumbers, default cities
//   node ingest.js --vertical=plumbers
//   node ingest.js --vertical=plumbers,heating-engineers,boiler-installers
//   node ingest.js --vertical=plumbers --city=London,Manchester
//   node ingest.js London,Manchester      # legacy: cities only, vertical=plumbers
//
// Vertical aliases map to a Google Places textQuery template. Add new verticals here.
// Each lead is tagged with `source_vertical` so we can A/B compare downstream.

const store = require('./leads-store');
require('./load-env');

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const DEFAULT_CITIES = [
  'London', 'Birmingham', 'Manchester', 'Leeds', 'Liverpool',
  'Sheffield', 'Bristol', 'Nottingham', 'Newcastle', 'Leicester',
  'Glasgow', 'Edinburgh', 'Cardiff',
];

// Vertical → Google Places query template. {city} gets substituted.
// All UK trades that map well onto Automatyn's WhatsApp-receptionist pitch.
const VERTICALS = {
  'plumbers':              'plumbers in {city} UK',
  'heating-engineers':     'gas safe heating engineers in {city} UK',
  'boiler-installers':     'boiler installation and repair in {city} UK',
  'drain-unblockers':      'drain unblocking services in {city} UK',
  'emergency-plumbers':    '24 hour emergency plumber in {city} UK',
  'electricians':          'electricians in {city} UK',
  'locksmiths':            'emergency locksmith in {city} UK',
  'roofers':               'roofers in {city} UK',
  'handymen':              'handyman services in {city} UK',
  'pest-control':          'pest control in {city} UK',
  'glaziers':              'glazier emergency window repair in {city} UK',
};

async function searchPlaces(query, vertical, city) {
  const url = 'https://places.googleapis.com/v1/places:searchText';
  const body = { textQuery: query, pageSize: 20 };
  const all = [];
  let pageToken = null;
  for (let i = 0; i < 3; i++) {
    const payload = pageToken ? { ...body, pageToken } : body;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,nextPageToken',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Places API ${res.status}: ${txt}`);
    }
    const data = await res.json();
    for (const p of (data.places || [])) all.push(p);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
    await new Promise(r => setTimeout(r, 2000));
  }
  return all;
}

async function run(verticals, cities) {
  if (!API_KEY) throw new Error('GOOGLE_PLACES_API_KEY not set');
  let created = 0, updated = 0, skipped = 0;
  const tally = {};
  for (const vertical of verticals) {
    const template = VERTICALS[vertical];
    if (!template) {
      console.warn(`Skipping unknown vertical: ${vertical}. Known: ${Object.keys(VERTICALS).join(', ')}`);
      continue;
    }
    tally[vertical] = { created: 0, updated: 0 };
    for (const city of cities) {
      const query = template.replace('{city}', city);
      console.log(`\n[${vertical} | ${city}] "${query}"`);
      let places;
      try { places = await searchPlaces(query, vertical, city); }
      catch (err) {
        console.error(`  ERROR: ${err.message}`);
        continue;
      }
      console.log(`  ${places.length} places`);
      for (const p of places) {
        const name = p.displayName?.text || '';
        if (!name) { skipped++; continue; }
        const partial = {
          business_name: name,
          website: p.websiteUri || '',
          phone: p.internationalPhoneNumber || '',
          address: p.formattedAddress || '',
          city,
          rating: p.rating || null,
          review_count: p.userRatingCount || null,
          source_vertical: vertical,
          source_query: query,
        };
        const r = store.upsert(partial);
        if (r.created) { created++; tally[vertical].created++; }
        else { updated++; tally[vertical].updated++; }
      }
    }
  }
  console.log(`\nDone. Created ${created}, updated ${updated}, skipped ${skipped}.`);
  console.log('Per-vertical:', JSON.stringify(tally, null, 2));
  console.log(store.stats());
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let verticals = ['plumbers'];
  let cities = DEFAULT_CITIES;
  let positional = null;
  for (const a of args) {
    if (a.startsWith('--vertical=')) {
      verticals = a.slice('--vertical='.length).split(',').map(s => s.trim()).filter(Boolean);
    } else if (a.startsWith('--city=')) {
      cities = a.slice('--city='.length).split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--list') {
      console.log('Available verticals:');
      for (const v of Object.keys(VERTICALS)) console.log(`  ${v.padEnd(22)} → "${VERTICALS[v]}"`);
      process.exit(0);
    } else if (!a.startsWith('--')) {
      positional = a;
    }
  }
  // Legacy: positional cities arg with default vertical=plumbers
  if (positional && cities === DEFAULT_CITIES) {
    cities = positional.split(',').map(s => s.trim()).filter(Boolean);
  }
  return { verticals, cities };
}

if (require.main === module) {
  const { verticals, cities } = parseArgs(process.argv);
  console.log(`Ingesting verticals=[${verticals.join(', ')}] across ${cities.length} cities`);
  run(verticals, cities).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run, VERTICALS };
