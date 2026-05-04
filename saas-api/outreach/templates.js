// Cold email templates for UK plumbers.
// Principles baked in:
// - Subject lines lowercase, curious, under 50 chars
// - Opening specific to the business (via {{intro_line}})
// - Pain stated in plumber terms, not SaaS jargon
// - Short (~70-90 words body), mobile-readable
// - Founder-led signature, first name only
// - Clear unsubscribe
//
// Variant tracking (Larry-brain framework):
// - E1 subject variants (hook): SUBJECTS_E1 — 3 options, rotated per send
// - E1 CTA variants (close): CTAS_E1 — 4 options, rotated per send
// - Each send records subject_id + cta_id on the lead for per-variant attribution
// - daily-report.js applies diagnostic matrix:
//     high opens + high replies → SCALE
//     high opens + low replies → FIX CTA
//     low opens + high replies → FIX SUBJECT
//     low opens + low replies → FULL RESET

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '');
}

// E1 SUBJECT VARIANTS (hooks)
// New copy 2026-05-04: money-loss framing, named-business specificity, no jargon.
const SUBJECTS_E1 = {
  S1: '{{business_name}} after-hours bookings',
  S2: 'saw {{business_name}} on Google, quick idea',
  S3: 'the £200 missed call',
};

// E1 CTA VARIANTS (close — slot into the end of the body)
// New copy 2026-05-04: removed binary/qualifier asks. Replaced with reply-friendly
// or genuinely passive options. Easier asks convert.
const CTAS_E1 = {
  C1_short: `Worth a 5-minute look?`,
  C2_reply: `Reply with the word "send" and I'll mail back the setup link.`,
  C3_passive: `If it's useful: automatyn.co/plumbers. If not, no follow-up from me.`,
  C4_link: `automatyn.co/plumbers if you want to skip the pitch.`,
};

// E1 body skeleton — CTA is appended at the end.
// New body 2026-05-04: lead with their loss + concrete £, drop "I built a tool"
// language, add Adam social proof, mechanism in one line.
function renderE1Body(vars, cta) {
  return `${vars.greeting}${vars.intro_line}

Most plumbers I talk to lose 2 or 3 evening enquiries a week. At £150-£300 a job, that's the kind of money you'd notice if it was sitting on the kitchen table.

Automatyn answers ${vars.business_name}'s WhatsApp out of hours, books the job, and texts you the lead before you're back at the van.

Adam at AB Plumbing in Birmingham signed up last week. Setup took two minutes.

${cta}

Patrick
Founder, Automatyn
${vars.unsubscribe_line}`;
}

// EMAIL 2 — Day 3 follow-up
// New copy 2026-05-04: open with a real question, not "bumping this up". Keep specific.
const EMAIL_2 = {
  subject: 'did you see this{{comma_first_name}}?',
  body: `{{greeting}}One follow-up, then I'll leave you to it.

Quick question: when someone messages {{business_name}} on WhatsApp at 8pm asking about a leaking radiator, what happens right now? Do they get a reply that night, or wait until the morning?

If it's the morning, they've probably rung the next plumber by then.

Automatyn handles that 8pm message for you, books them in, and sends you a summary so you wake up to a job, not a chase. Sits on your existing WhatsApp Business number, two-minute setup.

automatyn.co/plumbers if you want a look.

Patrick
{{unsubscribe_line}}`,
};

// EMAIL 3 — Day 5 breakup
// New copy 2026-05-04: lead with a concrete story, not a hypothetical.
const EMAIL_3 = {
  subject: 'last one',
  body: `{{greeting}}Last note, promise.

Adam runs a plumbing firm in Birmingham. Same size, same evening-enquiry problem. He set Automatyn up on his WhatsApp the day he signed up, and it now handles every message that comes in after he's wrapped his last job.

If {{business_name}} has the same gap, the link is below. If not, ignore this and have a solid week.

automatyn.co/plumbers

Patrick
{{unsubscribe_line}}`,
};

function buildUnsubscribeLine(email, token) {
  const url = `https://api.automatyn.co/u?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
  return `\n---\nNot interested? ${url}`;
}

function firstName(business_name) {
  if (!business_name) return 'there';
  const word = business_name.trim().split(/\s+/)[0];
  if (!word) return 'there';
  const skip = new Set([
    'the', 'a', 'an', 'mr', 'mrs', 'ms', '24/7',
    'london', 'leeds', 'manchester', 'birmingham', 'liverpool', 'sheffield',
    'bristol', 'nottingham', 'newcastle', 'leicester', 'glasgow', 'edinburgh',
    'cardiff', 'mayfair', 'east', 'west', 'north', 'south', 'central',
    'city', 'national', 'royal', 'best', 'premier', 'rapid', 'fast',
    'urgent', 'express', 'elite', 'prime', 'top', 'first', 'pro',
    'quick', 'smart', 'super', 'ultra', 'gold', 'silver', 'diamond',
    'ace', 'star', 'crown', 'empire', 'universal', 'metro', 'greater',
    'piccadilly', 'mayfair', 'kensington', 'chelsea', 'fulham', 'hackney',
    'islington', 'camden', 'wandsworth', 'tooting', 'wimbledon',
    'plumbing', 'heating', 'gas', 'boiler', 'pipe', 'pipes',
    'emergency', 'reliable', 'affordable', 'trusted',
  ]);
  if (skip.has(word.toLowerCase())) return 'there';
  if (/^[A-Z][a-z]+$/.test(word)) return word;
  return 'there';
}

// Round-robin variant picker based on an integer seed (e.g. count of sends).
// Stateless; caller passes seed so assignment is deterministic + distributable.
function pickVariantRoundRobin(keys, seed) {
  const arr = Object.keys(keys);
  return arr[seed % arr.length];
}

function buildEmail(step, lead, unsubscribeToken, opts = {}) {
  const name = lead.first_name && lead.first_name.trim() ? lead.first_name.trim() : '';
  const vars = {
    first_name: name,
    first_name_or_there: name || 'there',
    comma_first_name: name ? `, ${name}` : '',
    greeting: name ? `Hi ${name},\n\n` : '',
    business_name: lead.business_name || 'your business',
    intro_line: lead.intro_line || '',
    unsubscribe_line: buildUnsubscribeLine(lead.email, unsubscribeToken),
  };

  if (step === 1) {
    const subjectId = opts.subjectId || 'S1';
    const ctaId = opts.ctaId || 'C1_short';
    const subjectTpl = SUBJECTS_E1[subjectId] || SUBJECTS_E1.S1;
    const ctaText = CTAS_E1[ctaId] || CTAS_E1.C1_short;
    return {
      subject: render(subjectTpl, vars),
      body: renderE1Body(vars, render(ctaText, vars)),
      subjectId,
      ctaId,
    };
  }

  const tpl = step === 2 ? EMAIL_2 : EMAIL_3;
  return {
    subject: render(tpl.subject, vars),
    body: render(tpl.body, vars),
  };
}

module.exports = {
  buildEmail,
  firstName,
  SUBJECTS_E1,
  CTAS_E1,
  pickVariantRoundRobin,
  EMAIL_2,
  EMAIL_3,
};
