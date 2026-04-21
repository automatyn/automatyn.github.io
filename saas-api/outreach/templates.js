// Cold email templates for UK plumbers.
// Principles baked in:
// - Subject lines lowercase, curious, under 50 chars
// - Opening specific to the business (via {{intro_line}})
// - Pain stated in plumber terms, not SaaS jargon
// - Short (~70-90 words body), mobile-readable
// - Founder-led signature, first name only
// - Clear unsubscribe

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '');
}

// EMAIL 1 — Opener
// Goal: get a single-line reply. "Tell me more" or "send the link."
// Hook: specific observation about their business, then missed-message pain.
const EMAIL_1 = {
  subject: 'quick question about {{business_name}}',
  body: `{{greeting}}{{intro_line}}

Quick one. When someone WhatsApps {{business_name}} at 7am with a burst pipe, who answers before you're up?

I built a free tool that pairs to your WhatsApp Business in about 2 minutes, answers after-hours messages, takes bookings, and pings you with the lead. 25 free messages a month, no card needed.

Worth a 30-second look?

Patrick
Founder, Automatyn
{{unsubscribe_line}}`,
};

// EMAIL 2 — Day 3 follow-up
// Goal: re-surface, add social proof angle, low pressure
const EMAIL_2 = {
  subject: 're: {{business_name}}',
  body: `{{greeting}}Bumping this up in case it got buried.

The tool sits on your existing WhatsApp Business number — you don't need a new phone or app. When a customer messages after hours, it replies instantly ("I'm out on a job, Patrick will confirm in the morning"), captures their details and the problem, and you see everything when you wake up.

Takes two minutes to try. If it's not useful, you unpair it and nothing changes.

Automatyn.co/plumbers — link's here if you want to skip the pitch.

Patrick
{{unsubscribe_line}}`,
};

// EMAIL 3 — Day 5 breakup
// Goal: provoke a yes/no. Last touch.
const EMAIL_3 = {
  subject: 'last one',
  body: `{{greeting}}Last email from me, promise.

If missed evening enquiries aren't costing you bookings, ignore this. If they are — it's 2 minutes to set up and free forever on the starter tier.

automatyn.co/plumbers

Either way, wishing {{business_name}} a solid week.

Patrick
{{unsubscribe_line}}`,
};

function buildUnsubscribeLine(email, token) {
  const url = `https://api.automatyn.co/u?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
  return `\n---\nNot interested? ${url}`;
}

function firstName(business_name) {
  // Fallback if we don't have a real first name. Many plumbers trade as
  // "John Smith Plumbing" — take first word if it looks like a name.
  // Otherwise fall back to "there".
  if (!business_name) return 'there';
  const word = business_name.trim().split(/\s+/)[0];
  if (!word) return 'there';
  // Skip generic openers and place/descriptor words that aren't first names.
  // Many trade businesses brand as "Mayfair Plumbers", "East End Plumbers",
  // "Best Gas London", "City Plumbers", "National Plumbing" — none of those
  // first words are human names, so we fall back to "there".
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
  // If first word is capitalised and alphabetic, treat as name
  if (/^[A-Z][a-z]+$/.test(word)) return word;
  return 'there';
}

function buildEmail(step, lead, unsubscribeToken) {
  const tpl = step === 1 ? EMAIL_1 : step === 2 ? EMAIL_2 : EMAIL_3;
  const name = lead.first_name && lead.first_name.trim() ? lead.first_name.trim() : '';
  const vars = {
    first_name: name,
    greeting: name ? `Hi ${name},\n\n` : '',
    business_name: lead.business_name || 'your business',
    intro_line: lead.intro_line || '',
    unsubscribe_line: buildUnsubscribeLine(lead.email, unsubscribeToken),
  };
  return {
    subject: render(tpl.subject, vars),
    body: render(tpl.body, vars),
  };
}

module.exports = { buildEmail, firstName, EMAIL_1, EMAIL_2, EMAIL_3 };
