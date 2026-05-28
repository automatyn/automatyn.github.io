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

// E1 bodies follow the researched spec (2026-05-28): PAS compressed to 3-4 short
// sentences at a 5th-grade reading level, one light agitate beat, and a single
// interest-based CTA that asks about THEIR current process (the Gong 304K
// cold-stage finding). No link, no price, no product noun. Sources: Gong,
// Belkins 16.5M, Backlinko 12M, Boomerang reading-level study, Lavender.
const BODIES = {
  gardeners: (vars) => `${vars.greeting}${vars.intro_line}

Quick one. A homeowner messages ${vars.business_name} on a Saturday evening about a clearance or a regular round. That message usually sits unread till Monday. By then they have asked two other gardeners and booked whoever wrote back first.

Right now, what happens to those evening enquiries: do they just wait till morning, or have you got a way to catch them?

Patrick
${vars.unsubscribe_line}`,

  'tree-surgeons': (vars) => `${vars.greeting}${vars.intro_line}

Quick one. Someone sends ${vars.business_name} a photo of a hanging branch at 9pm asking if it is dangerous. They are not waiting till morning. They message the next surgeon on Google and book whoever answers first.

Right now, what happens to those after-hours messages: do they wait till you see them, or have you got a way to catch them?

Patrick
${vars.unsubscribe_line}`,

  roofers: (vars) => `${vars.greeting}${vars.intro_line}

Quick one. Wind brings tiles down at 8pm and the customer messages three roofers at once. They hire whoever replies first. If ${vars.business_name} reads it at 9am, the job has usually gone.

Right now, what happens to those evening messages: do some slip till morning, or are you reliably the first to reply?

Patrick
${vars.unsubscribe_line}`,
};

// Greeting fallback. A wrong name ("Hi Landspace,", "Hi Eco,") reads more
// robotic than no name, and a business's first word is almost never a person's
// name. So we deliberately do NOT guess a name from the business: callers pass
// an explicit first_name when they have one, otherwise the greeting is the safe,
// human "Hi there,". Kept as a function so the contract is explicit.
function deriveName() {
  return 'there';
}

// Scraped Google-listing names carry a category tail (e.g. "Beaufort & Rampton
// Landscapes - Garden Design, Landscaping and Maintenance, London"). Trim to the
// trading name so it reads naturally in a subject line and mid-sentence: take
// everything before the first " - " or comma, and cap the length.
function shortBusinessName(businessName) {
  if (!businessName) return 'your business';
  // Cut at the first hyphen (with or without surrounding spaces) or comma, which
  // is where Google listings append the category tail.
  let n = businessName.split(/\s*[-,]\s*/)[0].trim();
  // strip trailing legal suffixes that read oddly mid-sentence
  n = n.replace(/\s+(Limited|Ltd\.?|LLP)$/i, '').trim();
  if (n.length > 45) n = n.slice(0, 45).trim();
  return n || 'your business';
}

function buildSummerEmail(vertical, lead, unsubLine, subjectIdx = 0) {
  if (!SUBJECTS[vertical]) throw new Error(`Unknown summer vertical: ${vertical}`);
  const explicitName = (lead.first_name && lead.first_name.trim()) || '';
  const name = explicitName || deriveName(lead.business_name);
  const vars = {
    first_name: name,
    greeting: name && name !== 'there' ? `Hi ${name},\n\n` : 'Hi there,\n\n',
    business_name: shortBusinessName(lead.business_name),
    intro_line: lead.intro_line || '',
    unsubscribe_line: `\n\nNot interested? ${unsubLine}`,
  };
  const subjectTpl = SUBJECTS[vertical][subjectIdx % SUBJECTS[vertical].length];
  let subject = subjectTpl.replace(/\{\{business_name\}\}/g, vars.business_name);
  // Research spec: subject <= 50 chars. If a long business name pushes it over,
  // fall back to a name-free concrete subject for this vertical.
  if (subject.length > 50) {
    const fallback = { gardeners: 'the Saturday evening enquiries', 'tree-surgeons': '"is this tree dangerous" at 9pm', roofers: 'storm at 8pm, customer at 9am' };
    subject = fallback[vertical];
  }
  const body = BODIES[vertical](vars);
  return { subject, body, subjectId: `S_${vertical[0].toUpperCase()}${subjectIdx + 1}` };
}

module.exports = { buildSummerEmail, SUBJECTS, deriveName, shortBusinessName };
