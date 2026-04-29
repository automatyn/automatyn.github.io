#!/usr/bin/env node
// Reads candidates.json, produces drafts.json (consumed by build-page.js).
// Quality bar: only emits replies where we have a real angle. Skips otherwise.
// Usage: node draft-from-candidates.js [slot]   (slot = morning|afternoon|evening)

const fs = require('fs');
const path = require('path');

const dir = __dirname;
const slot = process.argv[2] || 'morning';
const cands = JSON.parse(fs.readFileSync(path.join(dir, 'candidates.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

const originalPools = {
  morning: [
    "Most small businesses don't have a marketing problem. They have a follow-up problem. The leads are already there. Nobody chases them on Tuesday at 6pm.",
    "If a customer asks at 9pm and you answer at 9am, the sale is already gone. Speed has quietly become the only differentiator left.",
    "Founders spend a year building the perfect onboarding then lose 40% of signups because nobody replies to 'is this legit?' for six hours."
  ],
  afternoon: [
    "The boring middle layer of AI for small business (follow-up, scheduling, review chasing) is where the actual money is. The rest is theatre.",
    "Every plumber I've talked to has the same bottleneck. Not leads, not pricing. A phone they can't pick up while they're under a sink.",
    "A receptionist that costs £30k/year and one that costs £30/month don't compete. The £30 one just shows up at 2am too."
  ],
  evening: [
    "The smallest businesses get the worst tools. Enterprise gets a Salesforce admin team. A solo electrician gets a notebook and a missed-call list.",
    "What SMBs want isn't an 'AI agent'. They want a thing that picks up the phone, books the job, and stops bothering them.",
    "Speed of reply beats quality of reply. A two-line answer in two minutes converts better than a perfect answer at lunch tomorrow."
  ]
};

// Topic detectors with hand-written, on-message replies. No template-mashing.
// Each rule returns {draft, reason} when text triggers it. Order matters — first match wins.
const angles = [
  {
    name: 'speed-or-response-time',
    test: t => /\b(slow response|response time|slow reply|hours to respond|takes forever|never reply|no one replies|reply faster)\b/i.test(t),
    drafts: [
      "The version of this nobody quantifies: every hour of delay roughly halves the reply-getting-read odds. Not the close. Just being read.",
      "Speed of reply has quietly become the moat. Two minutes beats a perfect answer at lunch tomorrow, every time."
    ],
    reason: 'speed/response-time angle'
  },
  {
    name: 'missed-calls-or-phone',
    test: t => /\b(missed call|missed calls|voicemail|nobody answers|can't pick up|cant pick up|phone rings|phone tag)\b/i.test(t),
    drafts: [
      "Tradespeople I know lose 1-2 jobs a week to this exact thing. Not to competitors. Just to the next person who picks up first.",
      "The cost of a missed call for a service business is usually ~£200 in lost job value. Stack a few a week and that's a holiday."
    ],
    reason: 'missed-calls angle'
  },
  {
    name: 'follow-up-leaky-funnel',
    test: t => /\b(follow up|follow-up|leaky funnel|forgot to reply|forgot to follow up|leads (going|are) cold|never followed up)\b/i.test(t),
    drafts: [
      "Most pipelines aren't broken at the top. They're broken at the second touch. The lead came in, nobody chased on Tuesday at 6pm, gone.",
      "Follow-up is unfair leverage. The CRM doesn't replace it; it just gives you somewhere to ignore it more efficiently."
    ],
    reason: 'follow-up angle'
  },
  {
    name: 'small-business-overwhelm',
    test: t => /\b(small business owner|smb|tradie|plumber|electrician|builder|sole trader)\b/i.test(t) && /\b(overwhelmed|drowning|burnt out|exhausted|tired|too much)\b/i.test(t),
    drafts: [
      "The honest version: most small business 'admin' could be done by a £30/month thing and it would buy back about a day a week.",
      "The bottleneck for solo operators almost always lives in the inbox and the missed-calls list. The work itself is fine."
    ],
    reason: 'SMB overwhelm angle'
  },
  {
    name: 'ai-for-smb',
    test: t => /\b(AI|GPT|LLM|chatbot|agent)\b/i.test(t) && /\b(small business|SMB|smb|trade|plumber|electrician|service business)\b/i.test(t),
    drafts: [
      "The wins for SMBs aren't the headline use cases. They're the boring middle: answering the phone, booking the slot, chasing the review.",
      "Most 'AI for small business' demos miss the point. The job isn't to be smart. It's to pick up at 11pm and not lose the booking."
    ],
    reason: 'AI-for-SMB nuance'
  },
  {
    name: 'build-in-public',
    test: t => /\b(build in public|building in public|launched today|just shipped|MVP|side project)\b/i.test(t),
    drafts: [
      "The third rewrite is usually where the actual product appears. The first two are learning what the problem actually is.",
      "Build-in-public is undefeated for one reason. Almost nobody else is willing to show the receipts."
    ],
    reason: 'builder relate'
  },
  {
    name: 'pricing-or-cost',
    test: t => /\b(too expensive|can't afford|cant afford|enterprise pricing|priced out|small business price|affordable)\b/i.test(t),
    drafts: [
      "The market for things at £30/month for SMBs is huge and almost completely ignored. Everyone is busy chasing £3k MRR per logo.",
      "Pricing for small business is a different game. Two £30 tools that show up beat one £300 tool that needs a consultant."
    ],
    reason: 'pricing angle'
  },
  {
    name: 'ai-replacing-jobs',
    test: t => /\b(replace|replaced|engineers|hiring|engineering team|humans again|jobs)\b/i.test(t) && /\b(AI|Claude|GPT|LLM|Codex|model)\b/i.test(t),
    drafts: [
      "The pendulum on this swings hard both ways every six months. The teams shipping the most output have stopped paying attention to either side of the argument.",
      "The boring answer that'll age best: smaller teams, more output, fewer meetings. The job description changes faster than the headcount."
    ],
    reason: 'AI-jobs nuance'
  },
  {
    name: 'codex-or-coding-tools',
    test: t => /\b(Codex|Copilot|Cursor|Claude Code|coding agent|AI coding|pair programming)\b/i.test(t),
    drafts: [
      "The interesting unlock isn't writing code faster. It's that the cost of throwing away the first attempt has dropped to almost zero.",
      "The thing nobody warned me about: once you ship at this speed, the bottleneck moves from coding to figuring out what's actually worth coding."
    ],
    reason: 'AI-coding angle'
  },
  {
    name: 'wealth-or-money',
    test: t => /\b(wealth|build wealth|money won't make|make you happy|spend less than|grow income|financial freedom)\b/i.test(t),
    drafts: [
      "The framing that finally clicked for me: time and money trade against each other until you build something that runs without you. That's the actual asset.",
      "Most 'spend less' advice misses the bigger lever. The income side has no ceiling. The expense side hits a floor pretty fast."
    ],
    reason: 'wealth/money angle'
  },
  {
    name: 'product-feel-craft',
    test: t => /\b(software|product|UX|user research|user testing|craft|made me feel|delightful)\b/i.test(t),
    drafts: [
      "The thing nobody can fake: software that respects your time. Most 'feel' debates are downstream of that one decision.",
      "User research being treated as an afterthought is usually a leadership signal more than a process one. Teams ship what's measured."
    ],
    reason: 'product-craft angle'
  },
  {
    name: 'tech-news-deal',
    test: t => /\b(billion|deal|signed|partnership|acquisition|announces|launched today)\b/i.test(t) && t.length > 100,
    drafts: [
      "The part of these announcements that ages best: not the headline number, but who's now locked into a multi-year roadmap they can't easily change.",
      "Worth watching the second-order effects on this. The competitors who don't move within 90 days usually never catch up."
    ],
    reason: 'tech-news angle'
  }
];

function pickDraft(text) {
  for (const a of angles) {
    if (a.test(text)) {
      // Pick first variant deterministically per slot, but vary by tweet_id parity
      return { draft: a.drafts[0], reason: a.reason };
    }
  }
  return null;
}

const ranked = (cands.candidates || []).slice().sort((a, b) => {
  const sa = (a.likes || 0) + (a.replies || 0) * 2 + (a.reposts || 0) * 3;
  const sb = (b.likes || 0) + (b.replies || 0) * 2 + (b.reposts || 0) * 3;
  return sb - sa;
});

const handleCount = {};
const replyDrafts = [];

for (const c of ranked) {
  if (!c.text || c.text.length < 50) continue;
  if ((handleCount[c.handle] || 0) >= 1) continue; // max 1 per handle per slot
  const r = pickDraft(c.text);
  if (!r) continue; // no angle = skip, hold quality bar
  if (r.draft.length > 270) continue;
  handleCount[c.handle] = (handleCount[c.handle] || 0) + 1;
  replyDrafts.push({
    id: `r${String(replyDrafts.length + 1).padStart(2, '0')}`,
    type: 'reply',
    target_handle: c.handle,
    target_followers: null,
    target_age: `${c.age_hours}h`,
    target_url: c.url,
    tweet_id: c.tweet_id,
    target_text: c.text.slice(0, 200),
    draft: r.draft,
    char_count: r.draft.length,
    reason: r.reason
  });
}

const originals = (originalPools[slot] || originalPools.morning).map((text, i) => ({
  id: `o${i + 1}`,
  type: 'original',
  draft: text,
  char_count: text.length,
  reason: `${slot} original`
}));

const drafts = [...originals, ...replyDrafts];

fs.writeFileSync(path.join(dir, 'drafts.json'), JSON.stringify({
  slot,
  date: today,
  drafts,
  source: {
    candidates_scraped_at: cands.scraped_at,
    candidates_count: (cands.candidates || []).length,
    drafts_emitted: drafts.length,
    replies_emitted: replyDrafts.length
  }
}, null, 2));

console.log(`Wrote drafts.json: ${drafts.length} total (${originals.length} originals + ${replyDrafts.length} replies)`);
console.log(`From ${(cands.candidates || []).length} candidates → ${replyDrafts.length} matched an angle. Quality bar held.`);
