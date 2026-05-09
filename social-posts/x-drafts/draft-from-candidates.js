#!/usr/bin/env node
// Reads all candidate sources (api / browser / search), merges + dedupes by tweet id,
// produces drafts.json (consumed by build-page.js).
// Quality bar: only emits replies where we have a real angle. Skips otherwise.
// Usage: node draft-from-candidates.js [slot]   (slot = morning|afternoon|evening)

const fs = require('fs');
const path = require('path');

const dir = __dirname;
const slot = process.argv[2] || 'morning';

// Per-producer files. Legacy candidates.json is read as a fallback so older
// runs (or any producer that hasn't been migrated) still work.
const SOURCES = ['candidates-api.json', 'candidates-browser.json', 'candidates-search.json', 'candidates.json'];
const seen = new Set();
const merged = [];
let scrapedAt = null;
const sourceStats = {};
for (const fname of SOURCES) {
  const fpath = path.join(dir, fname);
  if (!fs.existsSync(fpath)) continue;
  let data;
  try { data = JSON.parse(fs.readFileSync(fpath, 'utf8')); }
  catch (err) { console.warn(`skipping ${fname}: ${err.message}`); continue; }
  const list = data.candidates || [];
  let added = 0;
  for (const c of list) {
    const id = c.id || c.tweet_id || c.url || JSON.stringify([c.handle, c.text]).slice(0, 80);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(c);
    added++;
  }
  sourceStats[fname] = { available: list.length, added };
  if (data.scraped_at && (!scrapedAt || data.scraped_at > scrapedAt)) scrapedAt = data.scraped_at;
}
const cands = { scraped_at: scrapedAt, candidates: merged };
console.log(`Merged candidate sources:`, sourceStats, `→ ${merged.length} unique`);
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

// Reply-bait angles, all bent toward Automatyn's pillars (speed of reply, missed
// calls, follow-up, SMB overwhelm, AI receptionists, SMB pricing).
//
// Reply-bait rules (every draft):
//   1. Open with a number, percentage, or specific £/£/job — stops the scroll
//   2. Contrarian or "the version nobody mentions" framing — invites quote-tweets
//   3. End on a hook that begs a reply, not a closed thought
//   4. Under 200 chars where possible (no "Show more" cliff)
//   5. Specific to UK trades / SMBs (= telegraphs WHO you are)
//   6. No em-dashes, no banned hype words, no fake prices
//
// Each rule returns {draft, reason} when text triggers it. Order matters — first match wins.
const angles = [
  {
    name: 'speed-or-response-time',
    test: t => /\b(slow response|response time|slow reply|hours to respond|takes forever|never reply|no one replies|reply faster|response speed)\b/i.test(t),
    drafts: [
      "73% of customers go with whoever replies first. Not best. First. The plumbers who answer in 90 seconds win the job before competitors even see it.",
      "The version nobody quantifies: every hour you wait, the reply-getting-read odds roughly halve. Not closed. Just read.",
      "Two minutes flat beats a perfect answer at lunch tomorrow, every time. Speed is the only moat that compounds while you sleep.",
      "The boring stat: 78% of leads go to whoever replies inside 5 mins. Yet most SMBs reply in 4 hours. Where does the money go?"
    ],
    reason: 'speed/response-time angle'
  },
  {
    name: 'missed-calls-or-phone',
    test: t => /\b(missed call|missed calls|voicemail|nobody answers|can't pick up|cant pick up|phone rings|phone tag|phone calls?)\b/i.test(t),
    drafts: [
      "A UK plumber loses ~£200 every time the phone goes to voicemail. Stack 3 a week and that's a holiday they didn't take this year.",
      "Tradespeople I know lose 1-2 jobs a week to this. Not to competitors. To the next person who picks up first.",
      "The version nobody talks about: missed calls don't just lose the job. They train the customer to never call back.",
      "Service businesses leak £8-15k/year through unanswered calls between 5pm and 9am. Nobody puts it on the P&L because nobody can see it."
    ],
    reason: 'missed-calls angle'
  },
  {
    name: 'follow-up-leaky-funnel',
    test: t => /\b(follow up|follow-up|leaky funnel|forgot to reply|forgot to follow up|leads (going|are) cold|never followed up|second touch|nurtur)\b/i.test(t),
    drafts: [
      "Most pipelines aren't broken at the top. They're broken at the second touch. The lead came in, nobody chased on Tuesday at 6pm, gone forever.",
      "80% of sales need 5+ follow-ups. 44% of salespeople give up after 1. There's the entire game in two numbers.",
      "Follow-up is the only marketing channel where every competitor is asleep. Show up on Tuesday at 6pm and you've already won.",
      "The CRM doesn't fix follow-up. It just gives you a more organised way to feel guilty about not doing it."
    ],
    reason: 'follow-up angle'
  },
  {
    name: 'small-business-overwhelm',
    test: t => /\b(small business owner|smb|tradie|plumber|electrician|builder|sole trader|self-employed|solopreneur)\b/i.test(t) && /\b(overwhelmed|drowning|burnt out|burnout|exhausted|tired|too much|can't keep up|cant keep up|admin|paperwork)\b/i.test(t),
    drafts: [
      "The honest version: most SMB 'admin' could be done by a £30/mo thing and would buy back a day a week. The hard part is admitting how much time it eats.",
      "The bottleneck for sole traders almost always lives in two places: the inbox and the missed-calls list. The actual job is fine.",
      "Tradesmen don't have a marketing problem. They have a 6pm-on-Tuesday problem. The leads are there. Nobody chases.",
      "Solo operators waste 2-3 hours/day on admin that £200/mo of automation handles in seconds. The math is brutal once you draw it."
    ],
    reason: 'SMB overwhelm angle'
  },
  {
    name: 'ai-for-smb',
    test: t => /\b(AI|GPT|LLM|chatbot|agent|automation|automate|automated)\b/i.test(t) && /\b(small business|SMB|smb|trade|plumber|electrician|service business|local business|main street)\b/i.test(t),
    drafts: [
      "The wins for SMBs aren't the headline AI use cases. They're the boring middle: answering at 11pm, booking the slot, chasing the review.",
      "Most 'AI for small business' demos miss the actual job. The point isn't to be smart. It's to not lose the booking when the boss is asleep.",
      "The SMB unlock isn't ChatGPT-on-a-website. It's the AI that picks up the phone at midnight and books the £400 emergency callout.",
      "Local trades don't need AI agents. They need an AI that does what a £30k/yr receptionist does, for £30/month, that never calls in sick."
    ],
    reason: 'AI-for-SMB nuance'
  },
  {
    name: 'pricing-or-cost',
    test: t => /\b(too expensive|can't afford|cant afford|enterprise pricing|priced out|small business price|affordable|saas pricing|pricing model)\b/i.test(t),
    drafts: [
      "The market for £30/mo SMB tools is huge and almost completely ignored. Everyone's busy chasing £3k MRR enterprise logos that take 8 months to close.",
      "SMB pricing is a different game. Two £30 tools that show up daily beat one £300 tool that needs a consultant to install.",
      "The price ceiling for a UK trades app isn't what enterprise pays. It's what one missed call costs. Everything above that gets ignored.",
      "The thing enterprise SaaS people miss: an SMB doesn't pay £200/mo for software. They pay £200/mo for a person showing up. Frame it the right way and the price disappears."
    ],
    reason: 'pricing angle'
  },
  {
    name: 'ai-replacing-jobs',
    test: t => /\b(replace|replaced|engineers|hiring|engineering team|humans again|jobs|workforce|layoffs)\b/i.test(t) && /\b(AI|Claude|GPT|LLM|Codex|model|agent)\b/i.test(t),
    drafts: [
      "The honest version nobody says: AI isn't replacing engineers. It's replacing the missed-call list, the unanswered email, the forgot-to-follow-up. Boring jobs nobody fights for.",
      "The first jobs AI actually takes aren't the prestigious ones. They're the receptionist-at-2am job that no human wants anyway.",
      "Six months of headlines on AI replacing devs and the only role getting eaten quietly in the wild is the after-hours phone-answerer at SMBs. Worth watching.",
      "The pendulum on AI-vs-jobs swings hard both ways. The teams that ship most have stopped reading either side. They just hand AI the £30/hr admin work."
    ],
    reason: 'AI-jobs angle, redirected to receptionist replacement'
  },
  {
    name: 'codex-or-coding-tools',
    test: t => /\b(Codex|Copilot|Cursor|Claude Code|coding agent|AI coding|pair programming|vibe coding)\b/i.test(t),
    drafts: [
      "The interesting unlock isn't writing code faster. It's that the cost of throwing away the first version dropped to nearly zero. Same idea applies to email replies, btw.",
      "The bottleneck used to be coding. Now it's deciding what's worth coding. Same shift is hitting service businesses with reply-time: writing the response is fast, knowing which to send first is the new skill.",
      "Once you ship at this speed, the constraint moves from output to judgment. Same logic in customer service: 200 instant replies beats 20 perfect ones if you can't sort which conversation deserves which.",
      "The AI-coding lesson nobody applies elsewhere: speed of attempt matters more than quality of attempt. Same thing's true for sales follow-up. Try 5 angles fast, not 1 angle slowly."
    ],
    reason: 'AI-coding angle, redirected to speed/follow-up'
  },
  {
    name: 'product-feel-craft',
    test: t => /\b(software|product|UX|user research|user testing|craft|made me feel|delightful|design)\b/i.test(t) && /\b(small|local|trade|service|customer)\b/i.test(t),
    drafts: [
      "The thing SMB software keeps missing: trades-people don't want a beautiful dashboard. They want one that doesn't lose the £400 booking when the boss is on a job.",
      "Most B2B SaaS is designed for someone with 90 mins to learn it. SMB owners have 90 seconds. That gap is where 80% of products die.",
      "The 'feel' that wins for service businesses isn't delightful onboarding. It's the thing that picks up at 11pm and doesn't sound robotic.",
      "User research for trades is brutal: half won't have a website, the other half will tell you the website is useless. The actual workflow happens by phone and WhatsApp."
    ],
    reason: 'product-craft angle, redirected to SMB workflow'
  },
  {
    name: 'sales-or-revenue',
    test: t => /\b(sales|MRR|ARR|pipeline|leads?|conversion|revenue|customers?|churn)\b/i.test(t),
    drafts: [
      "The boring revenue lever nobody pulls: pick up the phone faster than competitors. 78% of buyers go with whoever replies first. Yet most SMBs reply in 4 hours.",
      "Pipeline isn't the bottleneck for most SMBs. Second-touch is. The lead came in, nobody followed up at 6pm Tuesday, gone forever.",
      "The cheapest customer-acquisition channel for trades is the phone they already have. Most leak £8-15k/year through unanswered calls between 5pm and 9am.",
      "Conversion rates obsess over funnel design. The real lift is response time. 5 mins beats 5 hours by 21x in actual close-rate studies."
    ],
    reason: 'sales/revenue angle, bent to speed-of-reply'
  },
  {
    name: 'hiring-or-team',
    test: t => /\b(hiring|hire|team|employees|staff|recruit|first hire|payroll)\b/i.test(t),
    drafts: [
      "The first hire most SMBs actually need isn't sales or marketing. It's whoever picks up the phone at 7pm. That role costs £30k/year. The AI version costs £30/month.",
      "Service businesses keep trying to hire receptionists in 2026. The honest version: a £30/mo AI does it, doesn't call in sick, and books the £400 job at 2am.",
      "Hiring is the slowest growth lever a small business has. Automating the after-hours phone is the fastest. Most still pick the slower one.",
      "The hiring math nobody runs: a UK plumber pays £25k/year for one receptionist. The same money buys 70 years of automated answering. Worth a thought."
    ],
    reason: 'hiring angle, bent to receptionist replacement'
  },
  {
    name: 'marketing-or-ads',
    test: t => /\b(marketing|ads|advertis|google ads|facebook ads|seo|content marketing|growth hack)\b/i.test(t),
    drafts: [
      "Most SMB marketing budgets are leaky buckets. £500/mo on Google Ads, then 40% of the calls that come in go to voicemail. The plug matters more than the tap.",
      "The cheapest marketing channel for trades is reply-time. Same lead, same ad spend, twice the conversion if you pick up in 2 mins instead of 2 hours.",
      "Tradies spend £400/mo on local SEO and lose £800/week to missed calls. The math is upside down for almost everyone in the sector.",
      "Marketing for SMBs got expensive. Reply-speed got cheap. One of these compounds, the other gets bid up every quarter."
    ],
    reason: 'marketing angle, bent to leaky-bucket'
  },
  {
    name: 'whatsapp-or-messaging',
    test: t => /\b(whatsapp|sms|texting|dm|messaging|messenger|inbox|chat)\b/i.test(t),
    drafts: [
      "WhatsApp is where small-business customers actually talk to small businesses. Email is where they go to be ignored. The platforms get this backwards.",
      "98% open rate on WhatsApp vs 22% on email. Most SMBs still send their booking confirmations by email. The cost of that habit is enormous and invisible.",
      "The inbox UK trades actually live in is WhatsApp. Not Gmail, not the website form. Customers pick the channel; SMBs argue with it.",
      "Half the bookings for UK plumbers happen via WhatsApp now. The ones who treat it as a real channel beat the ones who treat it as a side door, every time."
    ],
    reason: 'WhatsApp angle, on-pillar'
  },
  {
    name: 'after-hours-or-247',
    test: t => /\b(after hours|after-hours|24\/7|24x7|all night|midnight|weekend|out of hours|out-of-hours|on call|on-call|night shift)\b/i.test(t),
    drafts: [
      "70% of plumbing emergencies happen between 6pm and 9am. Most plumbers don't answer in that window. Whoever does, books the £400 job. Simple math, hard execution.",
      "After-hours is the unfair advantage nobody wants to work for. Three weekday evenings of automated answering = one extra job/week = an extra holiday/year.",
      "The version of 24/7 that actually works for SMBs isn't a human on call. It's a thing that picks up, qualifies, books, and lets the boss sleep.",
      "Out-of-hours is where the £400 emergency callouts live. Daytime competition is fierce. Nighttime competition is a voicemail box. Pick your battle."
    ],
    reason: 'after-hours angle, bent to receptionist value'
  },
  {
    name: 'customer-experience',
    test: t => /\b(customer experience|cx|customer service|service quality|support quality|friction|friction-free|frustrating|annoying)\b/i.test(t),
    drafts: [
      "The CX moment customers actually remember isn't the polished one. It's whether anyone replied at 7pm on Tuesday. Most SMBs lose customers in that exact slot.",
      "Customer service quality isn't about scripts. It's about whether anyone answered. 90% of complaints to UK trades are 'I tried calling, nobody picked up.'",
      "The biggest CX upgrade for service businesses costs £30/month: be reachable when the customer needs you, not when the office is open.",
      "The honest version: customers don't expect perfect. They expect responsive. The UK trades that get this beat the ones that don't, every quarter."
    ],
    reason: 'customer experience angle, bent to reply-time'
  },
  {
    name: 'productivity-or-time',
    test: t => /\b(productivity|productive|time management|busy|hustle|14[\- ]hour days?|work life balance|work-life|deep work|focus|distraction)\b/i.test(t),
    drafts: [
      "The honest productivity hack for solo operators: stop being your own receptionist. 2-3 hours/day go to admin a £30/mo bot would handle in seconds.",
      "Most 'work-life balance' advice for tradies is theoretical. The actual unlock is moving the phone off the boss's pocket so dinner stays uninterrupted.",
      "Productivity for service-business owners is a phone problem, not a calendar problem. Deal with the phone first; everything else gets easier.",
      "The hours people lose to admin in service businesses are mostly invisible. Track for one week and the number is brutal: 14-18 hrs of stuff a £30/mo automation handles."
    ],
    reason: 'productivity angle, bent to admin replacement'
  },
  {
    name: 'founders-or-bootstrap',
    test: t => /\b(founder|bootstrap|bootstrapped|self-funded|indie hacker|solopreneur|first \$\d+k|first £\d+k|got to \$|got to £|hit \$\d+k|hit £\d+k)\b/i.test(t),
    drafts: [
      "The unsexy founder lesson: most service-business revenue lives in the calls you're not picking up. Fix that one thing and the funnel suddenly looks healthy.",
      "Bootstrapped revenue grows fastest in the boring corners. Replying to leads in 2 mins instead of 2 hours doubles close-rate and costs you nothing.",
      "Indie founders spend years optimising the front of the funnel. The bottom (the second-touch, the after-hours pickup) usually has 10x more leverage and zero competition.",
      "First £10k MRR comes from picking up the phone faster than competitors. First £100k MRR comes from automating the picking-up. Same lever, different scale."
    ],
    reason: 'founder/bootstrap angle, bent to funnel-bottom'
  },
  {
    name: 'tech-trends-broad',
    test: t => /\b(AI agent|autonomous agent|agentic|workflow automation|n8n|zapier|make\.com|integrations?)\b/i.test(t),
    drafts: [
      "The agent use-case nobody hypes: a £30/mo thing that picks up the phone at 11pm, qualifies the lead, books the job. Boring. Profitable. Already deployed.",
      "Agentic workflows for trades aren't research-paper material. They're 4 nodes long: call comes in, AI qualifies, calendar slot picked, SMS confirmation. That's it.",
      "Automation for service businesses keeps over-engineering itself. 90% of the value is in one workflow: don't lose the call. Everything else is decoration.",
      "The 'AI agent' wave keeps targeting white-collar work. Meanwhile the highest-ROI deployment of agents is at the £30/mo end of the SMB market, where the work is reception, not research."
    ],
    reason: 'tech-trends angle, bent to receptionist deployment'
  },
  {
    name: 'voice-or-call-tech',
    test: t => /\b(voice ai|voice agent|voice chatbot|elevenlabs|11labs|cartesia|deepgram|conversational ai|phone tree|ivr)\b/i.test(t),
    drafts: [
      "Voice AI for SMBs isn't a tech problem anymore. It's a deployment problem. The under-served market is 5M UK service businesses paying nothing for after-hours coverage.",
      "Phone-trees are a 1990s artifact. The 2026 version is voice AI that actually answers, qualifies, and books. Most trades still use a voicemail nobody listens to.",
      "The voice-AI hype keeps demoing call-center scenarios. The actual deployment money is at the £30/mo end: solo plumbers who currently answer with a voicemail.",
      "IVR is a UX disaster. A modern voice AI that just talks back like a human and books the slot beats it on every metric: pickup, completion, customer satisfaction, cost."
    ],
    reason: 'voice-AI angle, on-pillar'
  }
];

// Score a draft on 4 reply-bait criteria. Returns 0-4. We require >=3 to ship.
// 1. Number opener — contains a percentage, £/£, or specific number in first 100 chars
// 2. Contrarian framing — contains a contradiction signal
// 3. Hook ending — closes on a question, surprise, or open thought (vs a closed period statement)
// 4. Tight length — <=160 chars (fits without "Show more" cliff on mobile)
function scoreDraft(d) {
  let score = 0;
  const head = d.slice(0, 100);
  // 1. Number/specific stat
  if (/(\d+%|\d+\.\d+%|\d+x|£\d|\$\d|\d+\s*(min|hr|hour|jobs?|leads?|calls?|year|years|customer))/i.test(head)) score++;
  // 2. Contrarian framing
  if (/(nobody|honest version|actually|version (no one|nobody) (says|talks about|mentions|admits)|the (boring|unsexy|hidden) (version|truth|answer)|most .* (miss|skip|ignore|get .* backwards|forget)|the (real|actual) (lift|lever|moat|cost|version)|the version that)/i.test(d)) score++;
  // 3. Hook ending — ends on question, "worth a thought", "?", interesting framing
  if (/(\?|worth (a|watching)|hard to argue|brutal|the math (is|gets) brutal|every time|simple math|hard execution|where (does|do)|simple|backwards|every quarter|invisible|hard work|won't catch up|the math|holiday they didn't take)$/i.test(d.trim())) score++;
  // 4. Tight length — <=160 chars
  if (d.length <= 160) score++;
  return score;
}

// Read recently-pushed drafts to avoid duplicating text across cycles. The firehose
// pushes to pending-x-drafts.json, so we look back at the last 24h of texts and
// down-rank any variant we just shipped.
function recentlyPushedTexts() {
  try {
    const fs = require('fs');
    const PENDING = '/home/marketingpatpat/openclaw/social-posts/pending-x-drafts.json';
    const all = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const set = new Set();
    for (const d of all) {
      if (!d.text || !d.created) continue;
      if (new Date(d.created).getTime() < cutoff) continue;
      set.add(d.text.trim());
    }
    return set;
  } catch { return new Set(); }
}
const _recentTexts = recentlyPushedTexts();

// Batch-scoped dedupe: track every draft text used in this drafter run so the
// SAME text never goes to two different candidates in one cycle. Combined with
// the 24h history dedupe in _recentTexts, this catches both:
//   (a) same text repeated across runs (24h dedupe handles this)
//   (b) same text repeated within a single run (this set handles this)
const _batchUsedTexts = new Set();

function pickDraft(text, candId) {
  for (const a of angles) {
    if (a.test(text)) {
      const idStr = String(candId || text);
      let h = 0;
      for (let i = 0; i < idStr.length; i++) h = (h * 31 + idStr.charCodeAt(i)) | 0;
      // Score every variant. Penalty if recently-pushed (24h history) OR already
      // used in THIS batch. Both penalties are -10 so any unused variant wins.
      const scored = a.drafts.map((d, i) => {
        const trimmed = d.trim();
        const recencyPenalty = _recentTexts.has(trimmed) ? 10 : 0;
        const batchPenalty   = _batchUsedTexts.has(trimmed) ? 10 : 0;
        return {
          draft: d,
          score: scoreDraft(d) - recencyPenalty - batchPenalty,
          idx: i,
        };
      });
      scored.sort((x, y) => y.score - x.score);
      const top = scored[0].score;
      const tied = scored.filter(s => s.score === top);
      const pick = tied[Math.abs(h) % tied.length];
      // Use the un-penalised score for the quality gate.
      const realScore = scoreDraft(pick.draft);
      if (realScore < 3) return null;
      // Mark this text as used in the batch so subsequent picks avoid it.
      _batchUsedTexts.add(pick.draft.trim());
      return { draft: pick.draft, reason: a.reason, score: realScore };
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
  if (!c.text || c.text.length < 30) continue; // loosened for firehose (was 50)
  if ((handleCount[c.handle] || 0) >= 2) continue; // max 2 per handle per slot (was 1)
  const r = pickDraft(c.text, c.id || c.url);
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
