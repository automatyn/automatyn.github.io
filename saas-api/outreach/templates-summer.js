// Summer 2026 outreach templates per niche.
// Used by send-handwritten-niche.js (E1 only — E2/E3 reuse main templates.js or get future-built).
//
// Niches: gardeners, tree-surgeons, roofers (peak May-Aug demand).
// Each niche: 3 subject options + 1 hand-tuned body.
// Body has {{intro_line}} which is hand-personalised per lead BEFORE send.

const SUBJECTS = {
  gardeners: [
    '{{business_name}} after-hours bookings',
    'the £400 missed quote',
    'saw {{business_name}}, quick idea',
  ],
  'tree-surgeons': [
    '{{business_name}} after-hours quotes',
    'the £600 missed tree job',
    '"is this tree dangerous" at 9pm',
  ],
  roofers: [
    'the £800 missed roof job',
    '{{business_name}} after-hours quotes',
    'storm at 8pm, customer at 9am',
  ],
};

const BODIES = {
  gardeners: (vars) => `${vars.greeting}${vars.intro_line}

Most gardeners I talk to lose 2-3 quote enquiries a week to evening WhatsApp messages that don't get seen until the next morning. At £200-£500 a job, that's real money sitting on the table.

Automatyn answers ${vars.business_name}'s WhatsApp out of hours, books the job, sends you the lead the next morning so you wake up to work, not a chase.

Sits on your existing WhatsApp Business number. Two-minute setup. $29/mo, no contract.

Worth a 5-minute look? automatyn.co

Patrick
Founder, Automatyn
${vars.unsubscribe_line}`,

  'tree-surgeons': (vars) => `${vars.greeting}${vars.intro_line}

When someone WhatsApps a photo of a hanging branch at 9pm asking "is this dangerous", they're not waiting until morning. They're messaging the next tree surgeon on Google.

Automatyn answers those messages on ${vars.business_name}'s WhatsApp inside 60 seconds, replies with a quote bracket, books the survey. You wake up to a booked job.

Sits on your existing WhatsApp Business number. $29/mo, no contract.

Worth a 5-minute look? automatyn.co

Patrick
Founder, Automatyn
${vars.unsubscribe_line}`,

  roofers: (vars) => `${vars.greeting}${vars.intro_line}

When wind brings tiles down at 8pm, the customer WhatsApps three roofers and hires whoever replies first. If ${vars.business_name} sees it at 9am tomorrow, the job's gone.

Automatyn answers those messages inside 60 seconds, asks for the photo, books the inspection. Roof jobs are £500-£5,000, so one saved enquiry a month pays for the tool many times over.

Sits on your existing WhatsApp Business number. $29/mo, no contract.

Worth a 5-minute look? automatyn.co

Patrick
Founder, Automatyn
${vars.unsubscribe_line}`,
};

function buildSummerEmail(vertical, lead, unsubLine, subjectIdx = 0) {
  if (!SUBJECTS[vertical]) throw new Error(`Unknown summer vertical: ${vertical}`);
  const name = (lead.first_name && lead.first_name.trim()) || '';
  const vars = {
    first_name: name,
    greeting: name ? `Hi ${name},\n\n` : '',
    business_name: lead.business_name || 'your business',
    intro_line: lead.intro_line || '',
    unsubscribe_line: `\n---\nNot interested? ${unsubLine}`,
  };
  const subjectTpl = SUBJECTS[vertical][subjectIdx % SUBJECTS[vertical].length];
  const subject = subjectTpl.replace(/\{\{business_name\}\}/g, vars.business_name);
  const body = BODIES[vertical](vars);
  return { subject, body, subjectId: `S_${vertical[0].toUpperCase()}${subjectIdx + 1}` };
}

module.exports = { buildSummerEmail, SUBJECTS };
