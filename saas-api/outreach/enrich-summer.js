#!/usr/bin/env node
// One-off enricher for summer-niche leads only (gardeners/tree-surgeons/roofers).
// Same as enrich-emails.js but filtered to summer verticals.
// Usage: node outreach/enrich-summer.js [limit=100]
const store = require('./leads-store');
const { enrichOne } = require('./enrich-emails');

async function run() {
  const limit = parseInt(process.argv[2], 10) || 100;
  const all = store.listAll();
  const SUMMER = new Set(['gardeners', 'tree-surgeons', 'roofers']);
  const targets = all.filter(l =>
    SUMMER.has(l.source_vertical) &&
    l.website &&
    !l.email &&
    !l.do_not_send &&
    !l.bounced
  ).slice(0, limit);

  console.log(`Enriching ${targets.length} summer leads (max ${limit})`);
  let found = 0, miss = 0, errs = 0;
  for (const lead of targets) {
    try {
      const r = await enrichOne(lead, { tryRender: false, tryYellFallback: false });
      if (r.ok) {
        found++;
        console.log(`  ✓ [${lead.source_vertical}] ${lead.business_name} → ${r.email}`);
      } else {
        miss++;
      }
    } catch (e) {
      errs++;
      console.log(`  ! ${lead.business_name}: ${(e.message || '').slice(0, 80)}`);
    }
  }
  console.log(`Done. Found ${found}, missed ${miss}, errs ${errs}.`);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
