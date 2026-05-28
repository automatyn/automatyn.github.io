// Summer 2026 outreach templates per niche.
// Rewritten 2026-05-28 to the v6 philosophy (see templates-v6.js) after the
// diagnosis found the old summer E1 carried the exact dual-path the team had
// already learned to drop: a link + price + "worth a 5-minute look?" soft CTA.
//
// Changes from the original summer templates:
//   1. E1 is conversation-only: NO link, NO price, NO product pitch sentence.
//   2. CTA is a single direct question that reuses the lead's own situation,
//      so the recipient feels rude not answering (the thing that earns replies).
//   3. Greeting never opens mid-sentence: when no first_name, fall back to a
//      name derived from the business, else "there" (mirrors v6 firstName()).
//   4. Pat handles the offer + /pricing.html in the reply thread, where the
//      geo-switcher renders GB=£29 per CLAUDE.md. No currency hardcoded.
//
// Niches: gardeners, tree-surgeons, roofers (peak May-Aug demand).

const SUBJECTS = {
  gardeners: [
    '{{business_name}} after 6pm',
    'quick one about {{business_name}}',
    'who answers the Saturday quotes',
  ],
  'tree-surgeons': [
    '{{business_name}} after 6pm',
    'quick one about {{business_name}}',
    '"is this tree dangerous" at 9pm',
  ],
  roofers: [
    '{{business_name}} after 6pm',
    'quick one about {{business_name}}',
    'storm at 8pm, customer at 9am',
  ],
};

// E1 bodies: personalised intro, one specific scenario, one question. No link, no price.
const BODIES = {
  gardeners: (vars) => `${vars.greeting}${vars.intro_line}

Quick one: when a homeowner messages ${vars.business_name} on a Saturday evening for a quote on a garden clearance or a regular maintenance round, those messages probably sit till Monday. By then they've asked two other gardeners and booked whoever replied first.

Do those evening enquiries just wait till morning, or have you got something catching them?

Patrick
${vars.unsubscribe_line}`,

  'tree-surgeons': (vars) => `${vars.greeting}${vars.intro_line}

Quick one: when someone WhatsApps ${vars.business_name} a photo of a hanging branch at 9pm asking "is this dangerous", they are not waiting until morning. They are messaging the next surgeon on Google.

Do those after-hours messages just sit till you see them, or have you got a way to catch them?

Patrick
${vars.unsubscribe_line}`,

  roofers: (vars) => `${vars.greeting}${vars.intro_line}

Quick one: when wind brings tiles down at 8pm, the customer WhatsApps three roofers and hires whoever replies first. If ${vars.business_name} sees it at 9am tomorrow, the job has usually gone.

When those evening messages land, are you reliably the one who replies first, or do some slip till morning?

Patrick
${vars.unsubscribe_line}`,
};

// Fallback name derived from the business when first_name is missing, so the
// body never opens cold mid-sentence. Mirrors templates-v6.js firstName().
function deriveName(businessName) {
  if (!businessName) return 'there';
  const word = businessName.trim().split(/\s+/)[0];
  if (!word) return 'there';
  const skip = new Set([
    'the', 'a', 'an', 'mr', 'mrs', 'ms',
    'london', 'leeds', 'manchester', 'birmingham', 'liverpool', 'sheffield',
    'bristol', 'nottingham', 'newcastle', 'leicester', 'glasgow', 'edinburgh',
    'cardiff', 'east', 'west', 'north', 'south', 'central', 'greater',
    'city', 'national', 'royal', 'best', 'premier', 'rapid', 'fast',
    'urgent', 'express', 'elite', 'prime', 'top', 'first', 'pro',
    'quick', 'smart', 'super', 'ultra', 'green', 'garden', 'gardens',
    'tree', 'trees', 'roof', 'roofing', 'landscape', 'landscapes',
  ]);
  if (skip.has(word.toLowerCase())) return 'there';
  if (/^[A-Z][a-z]+$/.test(word)) return word;
  return 'there';
}

function buildSummerEmail(vertical, lead, unsubLine, subjectIdx = 0) {
  if (!SUBJECTS[vertical]) throw new Error(`Unknown summer vertical: ${vertical}`);
  const explicitName = (lead.first_name && lead.first_name.trim()) || '';
  const name = explicitName || deriveName(lead.business_name);
  const vars = {
    first_name: name,
    greeting: name && name !== 'there' ? `Hi ${name},\n\n` : 'Hi there,\n\n',
    business_name: lead.business_name || 'your business',
    intro_line: lead.intro_line || '',
    unsubscribe_line: `\n\nNot interested? ${unsubLine}`,
  };
  const subjectTpl = SUBJECTS[vertical][subjectIdx % SUBJECTS[vertical].length];
  const subject = subjectTpl.replace(/\{\{business_name\}\}/g, vars.business_name);
  const body = BODIES[vertical](vars);
  return { subject, body, subjectId: `S_${vertical[0].toUpperCase()}${subjectIdx + 1}` };
}

module.exports = { buildSummerEmail, SUBJECTS, deriveName };
