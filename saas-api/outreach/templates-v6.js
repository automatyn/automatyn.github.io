// templates-v6.js — Cold email templates rewritten 2026-05-18 after 0/322 replies on v5.
//
// Diagnosis (from leads-store + Brevo):
//   322 E1 sent, 153 opens (47% open rate), 12 unsubs, 5 bounces, 0 replies.
//   Subjects work. Body + CTA do not.
//
// Changes from v5 (templates.js):
//   1. CTA is a single direct question, not a dual-path. Cold-email replies happen
//      when the recipient feels rude not answering. v5's "Reply Y or click link"
//      gave them an out (click link, never reply).
//   2. No link in E1. Link only appears in E3 (the breakup). E1 is conversation-only.
//   3. Body is 3 short paragraphs max, not 4. Stripped the "I built a free WhatsApp
//      bot" sentence — that's pitch, not curiosity.
//   4. Scenario changed from "burst pipe at 8pm" to "Saturday quote requests" —
//      burst pipes are emergencies plumbers DO take after-hours. Quotes for
//      routine work are the actual leakage.
//   5. Voice aligned with marketing/outreach-scripts.md canonical Email 1.
//
// Variant tracking preserved for daily-report.js diagnostic matrix.

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '');
}

// E1 SUBJECT VARIANTS — keep proven subjects from v5, those got 47% opens.
const SUBJECTS_E1 = {
  S1: '{{business_name}} after 6pm',
  S2: 'quick one about {{business_name}}',
  S3: 'who answers WhatsApp at 8pm',
};

// E1 CTA VARIANTS — single question, no link, no fork.
// All three force a 1-word reply. Pat handles each warm reply personally,
// then walks them to /pricing.html in the conversation.
const CTAS_E1 = {
  C1_yesno: `Do those messages just sit till morning, or do you have a system?`,
  C2_count: `How many of those landed at {{business_name}} last Saturday alone? Curious.`,
  C3_what_now: `What do you do with them right now? Reply one line, no pitch from me.`,
};

// E1 body — 3 paragraphs. Personalised intro, specific scenario, single question.
function renderE1Body(vars, cta) {
  return `${vars.greeting}${vars.intro_line}

Quick one: when a homeowner messages ${vars.business_name} on Saturday afternoon asking for a quote on a radiator install or a boiler service, those messages probably sit there till Monday. By then they've asked three other plumbers and booked whoever replied first.

${cta}

Patrick
${vars.unsubscribe_line}`;
}

// EMAIL 2 — Day 3. Same shape: question, no link.
const EMAIL_2 = {
  subject: 'one follow up{{comma_first_name}}',
  body: `{{greeting}}One follow up.

I'm not chasing a yes, I'm chasing a no. If {{business_name}} already catches the after-hours WhatsApps, brilliant, ignore me. If they don't, I'd like to know what you do instead.

What's the current process?

Patrick
{{unsubscribe_line}}`,
};

// EMAIL 3 — Day 5 breakup. THIS is where the link lives. Honest, short, with-an-out.
const EMAIL_3 = {
  subject: 'last note',
  body: `{{greeting}}Last note from me.

If after-hours WhatsApps to {{business_name}} are going unanswered, the tool I built is at automatyn.co. Free tier covers 25 conversations a month, no card, two-minute setup on your existing number.

If they're not, ignore this and have a solid week.

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
    'piccadilly', 'kensington', 'chelsea', 'fulham', 'hackney',
    'islington', 'camden', 'wandsworth', 'tooting', 'wimbledon',
    'plumbing', 'heating', 'gas', 'boiler', 'pipe', 'pipes',
    'emergency', 'reliable', 'affordable', 'trusted',
  ]);
  if (skip.has(word.toLowerCase())) return 'there';
  if (/^[A-Z][a-z]+$/.test(word)) return word;
  return 'there';
}

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
    const subjectId = opts.subjectId || 'S2';
    const ctaId = opts.ctaId || 'C1_yesno';
    const subjectTpl = SUBJECTS_E1[subjectId] || SUBJECTS_E1.S2;
    const ctaText = CTAS_E1[ctaId] || CTAS_E1.C1_yesno;
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
