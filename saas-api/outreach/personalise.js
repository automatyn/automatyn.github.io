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

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') cmdList(parseInt(args[0], 10) || 20);
else if (cmd === 'set') cmdSet(args[0], args.slice(1).join(' '));
else if (cmd === 'name') cmdName(args[0], args.slice(1).join(' '));
else if (cmd === 'stats') cmdStats();
else {
  console.log('Commands:');
  console.log('  list [N]            — print next N leads needing intro_line as JSON');
  console.log('  set <id> "<line>"   — save intro_line for lead');
  console.log('  name <id> "<name>"  — save scraped first_name for lead');
  console.log('  stats               — show store stats');
}
