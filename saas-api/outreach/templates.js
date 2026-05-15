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
// Rewritten 2026-05-15: 0/295 replies on prior template = FULL RESET per Larry-brain matrix.
// Voice reverted to /marketing/outreach-scripts.md playbook (Apr 17): plumber-shaped scene,
// free tier as the ask, no fake social proof, no setup fee (real pricing = $29/mo or free).
const SUBJECTS_E1 = {
  S1: '{{business_name}} after 6pm',
  S2: 'quick one about {{business_name}}',
  S3: 'who answers WhatsApp at 8pm',
};

// E1 CTA VARIANTS (close - dual path: Y reply OR self-serve free tier)
// We have no demo video, no demo number, no setup-fee product. The only real asks are:
// 1) reply Y and Patrick sets up the free tier by hand
// 2) hit automatyn.co and start the free tier themselves (no card needed)
// Every CTA below offers both.
const CTAS_E1 = {
  C1_y_or_link: `Reply Y and I'll set up the free tier on your number, takes 2 minutes. Or start it yourself: automatyn.co (free for 25 messages, no card).`,
  C2_question_then_link: `Out of curiosity, how many evening WhatsApps does {{business_name}} get on a Friday? If the number is more than zero, automatyn.co is free to try (no card).`,
  C3_link_first: `automatyn.co - free tier is 25 messages a month, no card, takes 2 minutes. Or reply Y and I'll do the setup for you.`,
};

// E1 body skeleton - playbook tone, plumber-shaped, free tier ask.
function renderE1Body(vars, cta) {
  return `${vars.greeting}${vars.intro_line}

Quick question. When someone messages ${vars.business_name} on WhatsApp at 8pm asking about a burst pipe, what happens? It probably waits until morning, and by then they've rung the next plumber on Google.

I built a free WhatsApp bot that catches those messages, asks the right questions (address, problem, photos), and texts you a summary so you can decide if it's worth the callout.

Free for 25 conversations a month. No card. Two-minute setup, sits on your existing number.

${cta}

Patrick
${vars.unsubscribe_line}`;
}

// EMAIL 2 - Day 3 follow-up.
// Rewritten 2026-05-15: open with a real specific question, free tier ask, no fake stories.
const EMAIL_2 = {
  subject: 'one follow up{{comma_first_name}}',
  body: `{{greeting}}One follow up, then I'll leave you to it.

Last Friday evening, how many WhatsApp messages came in to {{business_name}} after you'd packed up? If even one of them was a job worth chasing, that's the gap.

The bot is free for 25 messages a month. No card, no contract, two minute setup on your existing number. You stay in control: it just texts you the lead, you decide if you want to ring back.

Reply Y and I'll set it up for you. Or start it yourself at automatyn.co.

Patrick
{{unsubscribe_line}}`,
};

// EMAIL 3 - Day 5 breakup.
// Rewritten 2026-05-15: short, honest, no fake customer, just the link.
const EMAIL_3 = {
  subject: 'last note',
  body: `{{greeting}}Last note from me.

If after-hours WhatsApps are getting missed at {{business_name}}, the tool is at automatyn.co. Free to start (25 messages, no card), takes 2 minutes.

If not, ignore this and have a solid week.

Patrick
{{unsubscribe_line}}`,
};

function buildUnsubscribeLine(email, token) {
  const url = `https://api.automatyn.co/u?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
  return `\n\nNot interested? ${url}`;
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
