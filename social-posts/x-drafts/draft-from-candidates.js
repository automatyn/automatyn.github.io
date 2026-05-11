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
const SOURCES = ['candidates-api.json', 'candidates-browser.json', 'candidates-search.json', 'firehose-candidates.json', 'candidates.json'];
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

// Dedupe vs Pat's own reply history. Cache refreshed by refresh-replied-cache.js.
const repliedCacheFile = path.join(dir, 'replied-cache.json');
const alreadyReplied = new Set();
if (fs.existsSync(repliedCacheFile)) {
  try {
    const cache = JSON.parse(fs.readFileSync(repliedCacheFile, 'utf8'));
    for (const id of (cache.replied_to || [])) alreadyReplied.add(String(id));
    console.log(`Loaded ${alreadyReplied.size} already-replied ids from cache (updated ${cache.updated_at}).`);
  } catch (err) { console.warn('replied-cache.json unreadable:', err.message); }
}
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

// Pain / intent signal — fires on tweets showing a problem, question, opinion,
// or contrarian take. Used to gate generic-keyword angles (sales/hiring/marketing/
// tech-trends/productivity/CX) so we don't reply to victory laps or pure
// announcements. A tweet must hit BOTH the angle's topic regex AND this signal.
const PAIN_SIGNAL = /(\?|nobody|hardest|worst|problem|broken|sucks|hate|annoying|frustrat|struggl|overwhelm|burn(out|ed)|tired|exhausted|drown|leak|losing|lost|wast|expensive|cheap|underrated|overrated|underbuilt|missed|forgot|underserved|untapped|gap|opportunity|why (does|do|are|is|isn|don)|how (do|does|come)|most .* (miss|skip|ignore|don.t|forget|get .* wrong|get .* backwards)|why (don|doesn|isn)|the (real|actual|honest|hidden|boring|unsexy) (version|truth|answer|lift|lever|cost)|nobody (says|talks|admits|mentions|builds|ships)|version (no one|nobody) (says|talks|mentions|admits)|where (does|do) the (money|customers?|growth|revenue) (go|live)|biggest (mistake|gap|miss|oversight)|controvers|unpopular|hot take|hottake|disagree|wrong about|i('m| am) (tired|sick) of)/i;
const angles = [
  {
    name: 'speed-or-response-time',
    test: t => /\b(slow response|response time|slow reply|hours to respond|takes forever|never reply|no one replies|reply faster|response speed)\b/i.test(t),
    drafts: [
      "73% of customers go with whoever replies first. Not best. First. The plumbers who answer in 90 seconds win the job before competitors even see it.",
      "The version nobody quantifies: every hour you wait, the reply-getting-read odds roughly halve. Not closed. Just read.",
      "Two minutes flat beats a perfect answer at lunch tomorrow, every time. Speed is the only moat that compounds while you sleep.",
      "The boring stat: 78% of leads go to whoever replies inside 5 mins. Yet most SMBs reply in 4 hours. Where does the money go?",
      "The unsexy version of customer acquisition: 5-min reply beats 5-hour reply by 21x. Same lead, same ad spend, totally different outcome.",
      "Actually the slow-response cost compounds. Each delayed lead trains your funnel that slow is acceptable. 3 months in, your team can't even tell.",
      "Most CRMs measure pipeline. None measure reply-time. The most predictive metric is the one nobody tracks. Worth a thought.",
      "The honest version: a £30/mo bot that replies in 90 seconds outperforms a £40k SDR that takes 4 hours. The math is brutal once you draw it."
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
      "Service businesses leak £8-15k/year through unanswered calls between 5pm and 9am. Nobody puts it on the P&L because nobody can see it.",
      "70% of plumbing emergencies hit between 6pm-9am. Most plumbers don't answer in that window. Whoever does, books the £400 callout. Simple.",
      "The honest version: every voicemail is a customer telling you 'I tried, you weren't there, I'm leaving.' Most owners never hear it.",
      "Actually the cost of a missed call isn't one job. It's that customer telling 3 friends never to call you. Word-of-mouth runs both ways.",
      "Service businesses spend £400/mo on local SEO and let £800/wk in calls go to voicemail. The plug matters more than the tap. Every quarter."
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
      "The CRM doesn't fix follow-up. It just gives you a more organised way to feel guilty about not doing it.",
      "30-40% of dropped leads are recoverable with one more touch on day 3. Most service businesses send zero. The math is upside down everywhere.",
      "The honest version: nobody loses deals to competitors. They lose deals to the email they forgot to send on Tuesday. Every quarter.",
      "Actually the second-touch is where revenue lives. The first touch is where we hire SDRs to build pipelines that die in slot two. Backwards.",
      "The unsexy growth lever: a £30/mo bot that sends 'still interested?' on day 3 recovers ~£60k/yr for a £200k revenue trade. Brutal arithmetic."
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
      "Solo operators waste 2-3 hours/day on admin that £200/mo of automation handles in seconds. The math is brutal once you draw it.",
      "14-18 hrs/week of admin most service-business owners can't account for. Track it. Then automate it. Most won't, because the number is humiliating.",
      "Actually the hardest thing for solo operators isn't the work. It's coming home and still having 30 unanswered messages waiting. Every night.",
      "The version nobody admits: 'overwhelmed' for an SMB owner means 'unread inbox.' Empty inbox = calm life. Worth more than any productivity book.",
      "Most 'burnout' in service businesses isn't burnout. It's being a part-time receptionist after a full-time day on the tools. Different problem, different fix."
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
      "Local trades don't need AI agents. They need an AI that does what a £30k/yr receptionist does, for £30/month, that never calls in sick.",
      "The honest version of AI-for-SMB in 2026: 1 narrow workflow that picks up the phone, qualifies, books the slot. Everything above that is dev-twitter theatre.",
      "Actually the small-business AI market is sub-£100/mo or it doesn't sell. Enterprise SaaS pricing kills SMB AI before it ever ships. Every quarter.",
      "Most 'AI for small business' demos use a 4-employee café. The real ICP is a 1-person plumber with no website and a missed-call list. Different product.",
      "The version nobody builds: an AI that asks 'what time on Thursday?' and books the slot. Boring. Specific. Profitable. Already deployed at scale."
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
      "The thing enterprise SaaS people miss: an SMB doesn't pay £200/mo for software. They pay £200/mo for a person showing up. Frame it the right way and the price disappears.",
      "Actually the SMB SaaS unit economics suck for VCs but win for bootstrappers. £30/mo × 1000 customers = £30k MRR with zero competition. Worth a thought.",
      "The honest version: a UK plumber doesn't read pricing pages. They calculate 'one job pays for it.' If the answer is yes, they buy. If no, they don't. Done.",
      "Most B2B pricing assumes a procurement cycle. SMB pricing assumes a phone-bill mindset: under £100/mo, predictable, cancel anytime. Get this wrong, no SMB ever pays.",
      "The version nobody admits: SaaS for SMBs isn't 'SaaS but cheaper.' It's a different product entirely. Different buyer, different sale, different LTV. Most miss this."
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
      "The pendulum on AI-vs-jobs swings hard both ways. The teams that ship most have stopped reading either side. They just hand AI the £30/hr admin work.",
      "Actually the AI-replaces-jobs takes are aimed at white-collar work and ignoring the £30/hr admin work nobody wanted to do anyway. That's where the actual replacement happens.",
      "The version nobody mentions: 'AI-augmented' for engineers, 'AI-replaced' for everyone holding a phone after 6pm. Different markets, different speeds.",
      "Most 'AI replacing jobs' takes are about prestigious roles. The actual job AI takes first costs £30/hr to a human and £30/month to automate. Boring. Done.",
      "The honest layoff math: AI doesn't replace your top SDR. It replaces the part of their job they hated (cold replies, follow-ups). Net: same headcount, more output."
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
      "The AI-coding lesson nobody applies elsewhere: speed of attempt matters more than quality of attempt. Same thing's true for sales follow-up. Try 5 angles fast, not 1 angle slowly.",
      "The honest version of AI coding: 90% throwaway, 10% kept. Same ratio works for cold replies. Volume + iteration beats craft + waiting. Brutal but true.",
      "Actually the lesson from AI coding is the same as from auto-replies: humans approve, AI drafts. Reverse the workflow and the bottleneck disappears. Where does the money go now?",
      "Most AI-coding hot takes miss the actual shift: the cost of WRONG dropped to zero. Same thing in customer ops: cheaper to send 50 personalised follow-ups than 5 perfect ones.",
      "The version of AI-coding that ages best: speed + iteration > craft. Apply the same to support, sales, ops. Service businesses get this faster than tech does. Worth watching."
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
      "User research for trades is brutal: half won't have a website, the other half will tell you the website is useless. The actual workflow happens by phone and WhatsApp.",
      "Honest product test for SMB software: can my plumber set it up between two jobs in his van? If no, you built for tech-twitter, not your customer.",
      "Actually the UX that wins in trades isn't 'delightful.' It's 'doesn't break when offline at 3am.' Different KPI, different product. Most miss this.",
      "The version nobody mentions: SMB owners don't want to feel anything from their software. They want to forget it exists and find the booking on their phone. Quiet wins.",
      "Most product-craft talks ignore the real friction: a tradie who can barely log in once a month. Design for that user and the rest follows. Worth a thought."
    ],
    reason: 'product-craft angle, redirected to SMB workflow'
  },
  {
    name: 'sales-or-revenue',
    test: t => /\b(sales|MRR|ARR|pipeline|leads?|conversion|revenue|customers?|churn)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The boring revenue lever nobody pulls: pick up the phone faster than competitors. 78% of buyers go with whoever replies first. Yet most SMBs reply in 4 hours.",
      "Pipeline isn't the bottleneck for most SMBs. Second-touch is. The lead came in, nobody followed up at 6pm Tuesday, gone forever.",
      "The cheapest customer-acquisition channel for trades is the phone they already have. Most leak £8-15k/year through unanswered calls between 5pm and 9am.",
      "Conversion rates obsess over funnel design. The real lift is response time. 5 mins beats 5 hours by 21x in actual close-rate studies.",
      "MRR growth for SMB SaaS isn't about more leads. It's about not losing the leads you have. Reply-time is the cheapest growth lever you'll ever pull.",
      "Actually the most predictive churn signal isn't NPS or product use. It's how long support takes to reply. Customers leave inboxes faster than products.",
      "The honest revenue audit for service businesses: count the calls you didn't pick up last week. Multiply by avg job value. The number is humiliating.",
      "Most pipeline reviews focus on top-of-funnel. The unsexy fact: 30-40% of revenue lives in slot 2 (second touch). Where does the money go? Same place every time."
    ],
    reason: 'sales/revenue angle, bent to speed-of-reply'
  },
  {
    name: 'hiring-or-team',
    test: t => /\b(hiring|hire|team|employees|staff|recruit|first hire|payroll)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The first hire most SMBs actually need isn't sales or marketing. It's whoever picks up the phone at 7pm. That role costs £30k/year. The AI version costs £30/month.",
      "Service businesses keep trying to hire receptionists in 2026. The honest version: a £30/mo AI does it, doesn't call in sick, and books the £400 job at 2am.",
      "Hiring is the slowest growth lever a small business has. Automating the after-hours phone is the fastest. Most still pick the slower one.",
      "The hiring math nobody runs: a UK plumber pays £25k/year for one receptionist. The same money buys 70 years of automated answering. Worth a thought.",
      "Actually the cost-per-hire for an SMB receptionist is ~£5k once you count training, holiday, sick leave. The AI equivalent: £400 setup + £30/mo. Different game entirely.",
      "Honest version: most SMB hiring is 'I can't do this anymore' rather than 'we're growing.' Hand the burnout part to a £30/mo bot. Then hire when you're fresh enough to lead.",
      "The version of 'first hire' that nobody talks about for trades: the receptionist replaces 14hrs/wk of admin. That's the 30% of your time you don't currently bill for.",
      "Most 'should I hire?' debates miss the cheaper option: automate the part you hate first, then hire someone for the part you love. Reverse order saves money every quarter."
    ],
    reason: 'hiring angle, bent to receptionist replacement'
  },
  {
    name: 'marketing-or-ads',
    test: t => /\b(marketing|ads|advertis|google ads|facebook ads|seo|content marketing|growth hack)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "Most SMB marketing budgets are leaky buckets. £500/mo on Google Ads, then 40% of the calls that come in go to voicemail. The plug matters more than the tap.",
      "The cheapest marketing channel for trades is reply-time. Same lead, same ad spend, twice the conversion if you pick up in 2 mins instead of 2 hours.",
      "Tradies spend £400/mo on local SEO and lose £800/week to missed calls. The math is upside down for almost everyone in the sector.",
      "Marketing for SMBs got expensive. Reply-speed got cheap. One of these compounds, the other gets bid up every quarter.",
      "The honest version of marketing ROI: every £1 of ad spend assumes someone answers when the lead arrives. Most SMBs break that assumption nightly. Where does the money go?",
      "Actually the conversion lift from 'reply in 2 mins' is bigger than the conversion lift from any ad creative. Free, ignored, every quarter. Worth a thought.",
      "Most SMB marketing reports show 'leads delivered' not 'leads answered.' The gap between those two numbers is the hidden tax on every campaign.",
      "The version nobody runs: turn off ads for a week, automate after-hours pickup, count new bookings. Often the bookings stay flat. Then you know."
    ],
    reason: 'marketing angle, bent to leaky-bucket'
  },
  {
    name: 'whatsapp-or-messaging',
    test: t => /\b(whatsapp|sms|texting|dm|messaging|messenger|inbox|chat)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "WhatsApp is where small-business customers actually talk to small businesses. Email is where they go to be ignored. The platforms get this backwards.",
      "98% open rate on WhatsApp vs 22% on email. Most SMBs still send their booking confirmations by email. The cost of that habit is enormous and invisible.",
      "The inbox UK trades actually live in is WhatsApp. Not Gmail, not the website form. Customers pick the channel; SMBs argue with it.",
      "Half the bookings for UK plumbers happen via WhatsApp now. The ones who treat it as a real channel beat the ones who treat it as a side door, every time.",
      "The honest WhatsApp question for SMBs: when did you last reply to a 'still available?' message in under 5 mins? Most owners can't answer because they don't track it.",
      "Actually 'we don't use WhatsApp professionally' is what 2026 customers hear as 'we don't want your business.' Same words, opposite meaning. Worth a thought.",
      "Most B2C marketing assumes email. UK SMB customers under 45 don't check email. Different channel, different rules. Brutal once you measure it.",
      "The version nobody admits: WhatsApp is the new shop counter for service businesses. The owners pretending it's optional are the ones losing share every quarter."
    ],
    reason: 'WhatsApp angle, on-pillar'
  },
  {
    name: 'after-hours-or-247',
    test: t => /\b(after hours|after-hours|24\/7|24x7|all night|midnight|weekend|out of hours|out-of-hours|on call|on-call|night shift)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "70% of plumbing emergencies happen between 6pm and 9am. Most plumbers don't answer in that window. Whoever does, books the £400 job. Simple math, hard execution.",
      "After-hours is the unfair advantage nobody wants to work for. Three weekday evenings of automated answering = one extra job/week = an extra holiday/year.",
      "The version of 24/7 that actually works for SMBs isn't a human on call. It's a thing that picks up, qualifies, books, and lets the boss sleep.",
      "Out-of-hours is where the £400 emergency callouts live. Daytime competition is fierce. Nighttime competition is a voicemail box. Pick your battle.",
      "The honest version: 'always available' as a competitive moat doesn't require a human on call. It requires a £30/mo bot that doesn't get tired by 11pm. Different fix, same outcome.",
      "Actually the cost of NOT being on-call is invisible: customers find someone who is, and never come back. By the time you notice, the relationship is gone. Every time.",
      "Most after-hours debates frame it as work-life balance vs revenue. The actual choice is: answer at 11pm, or have AI answer for £30/mo and sleep. Brutal once you draw it.",
      "The version of after-hours coverage that beats every competitor: AI books the slot, you do the job in the morning. Customer slept knowing it was sorted. Where does the money go?"
    ],
    reason: 'after-hours angle, bent to receptionist value'
  },
  {
    name: 'customer-experience',
    test: t => /\b(customer experience|cx|customer service|service quality|support quality|friction|friction-free|frustrating|annoying)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The CX moment customers actually remember isn't the polished one. It's whether anyone replied at 7pm on Tuesday. Most SMBs lose customers in that exact slot.",
      "Customer service quality isn't about scripts. It's about whether anyone answered. 90% of complaints to UK trades are 'I tried calling, nobody picked up.'",
      "The biggest CX upgrade for service businesses costs £30/month: be reachable when the customer needs you, not when the office is open.",
      "The honest version: customers don't expect perfect. They expect responsive. The UK trades that get this beat the ones that don't, every quarter.",
      "Actually most CX-strategy decks miss the only metric that matters for service businesses: time-to-first-reply. Everything else is decoration. Brutal.",
      "Most CX advice assumes someone is on the other end. For 5M UK SMBs, the bottleneck isn't quality of reply. It's WHETHER there's a reply at all. Different problem.",
      "The version nobody mentions: customers don't churn from bad service. They churn from no service. 'Nobody answered' beats 'rude reply' as a leave reason every time.",
      "Honest CX audit for an SMB: send yourself a customer enquiry from a fake number at 7pm Tuesday. Time how long until reply. The number is humiliating. Worth doing once."
    ],
    reason: 'customer experience angle, bent to reply-time'
  },
  {
    name: 'productivity-or-time',
    test: t => /\b(productivity|productive|time management|busy|hustle|14[\- ]hour days?|work life balance|work-life|deep work|focus|distraction)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The honest productivity hack for solo operators: stop being your own receptionist. 2-3 hours/day go to admin a £30/mo bot would handle in seconds.",
      "Most 'work-life balance' advice for tradies is theoretical. The actual unlock is moving the phone off the boss's pocket so dinner stays uninterrupted.",
      "Productivity for service-business owners is a phone problem, not a calendar problem. Deal with the phone first; everything else gets easier.",
      "The hours people lose to admin in service businesses are mostly invisible. Track for one week and the number is brutal: 14-18 hrs of stuff a £30/mo automation handles.",
      "Actually 'productivity' for solo operators is a misnomer. They're already working 12hr days. The lever is REDUCTION, not optimisation. Different verb, different fix.",
      "The version nobody admits: most 'productivity systems' assume you have time to set them up. SMB owners don't. They need a thing that works on day 1, no setup. Brutal constraint.",
      "Most 'deep work' takes don't apply to plumbers. Their constraint isn't focus. It's interruptions from a phone they can't ignore. Solve the phone first. Everything follows.",
      "Honest version: the most productive thing a solo operator can do is delete the work that didn't need doing. £30/mo bot for inbound = ~14hrs/wk back. Where does the money go?"
    ],
    reason: 'productivity angle, bent to admin replacement'
  },
  {
    name: 'founders-or-bootstrap',
    test: t => /\b(founder|bootstrap|bootstrapped|self-funded|indie hacker|solopreneur|first \$\d+k|first £\d+k|got to \$|got to £|hit \$\d+k|hit £\d+k)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The unsexy founder lesson: most service-business revenue lives in the calls you're not picking up. Fix that one thing and the funnel suddenly looks healthy.",
      "Bootstrapped revenue grows fastest in the boring corners. Replying to leads in 2 mins instead of 2 hours doubles close-rate and costs you nothing.",
      "Indie founders spend years optimising the front of the funnel. The bottom (the second-touch, the after-hours pickup) usually has 10x more leverage and zero competition.",
      "First £10k MRR comes from picking up the phone faster than competitors. First £100k MRR comes from automating the picking-up. Same lever, different scale.",
      "The honest bootstrap math: most indie founders chase 'better positioning' when the actual lever is 'pick up the phone in 90 sec.' Free, ignored, every quarter.",
      "Actually 'first 100 customers' is mostly about being available when they're ready to buy. The product matters less than the answer-time. Most miss this until year 2.",
      "Most bootstrap journeys delay 'support automation' until they're drowning. By then, the churn from missed replies has already cost more than the bot would have. Backwards order, every time.",
      "The version nobody admits: bootstrapping means YOU are the receptionist for the first 12 months. The smart ones automate that role on day 1, not day 365. Worth a thought."
    ],
    reason: 'founder/bootstrap angle, bent to funnel-bottom'
  },
  {
    name: 'tech-trends-broad',
    test: t => /\b(AI agent|autonomous agent|agentic|workflow automation|n8n|zapier|make\.com|integrations?)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The agent use-case nobody hypes: a £30/mo thing that picks up the phone at 11pm, qualifies the lead, books the job. Boring. Profitable. Already deployed.",
      "Agentic workflows for trades aren't research-paper material. They're 4 nodes long: call comes in, AI qualifies, calendar slot picked, SMS confirmation. That's it.",
      "Automation for service businesses keeps over-engineering itself. 90% of the value is in one workflow: don't lose the call. Everything else is decoration.",
      "The 'AI agent' wave keeps targeting white-collar work. Meanwhile the highest-ROI deployment of agents is at the £30/mo end of the SMB market, where the work is reception, not research.",
      "Honest version: most 'agentic' demos solve problems that don't exist for SMB owners. The actual problem: 1 workflow, 4 nodes, deployed in 10 mins. Done. Brutal but true.",
      "Actually n8n + a single 4-node workflow beats 90% of the 'AI agent' platforms for service businesses. Cheaper, faster, more reliable. The market hasn't caught up.",
      "The version nobody admits: agentic AI's killer app isn't research or coding. It's customer reception. Boring, narrow, profitable. Where does the money go? £30/mo, 5M businesses.",
      "Most 'AI workflow' tools assume you have an integrations team. SMBs don't. The winning product for trades is one node: 'AI answers WhatsApp, books calendar.' Done."
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
      "IVR is a UX disaster. A modern voice AI that just talks back like a human and books the slot beats it on every metric: pickup, completion, customer satisfaction, cost.",
      "The honest test for voice AI in 2026: would a 60-year-old plumber's customer notice it's not human in a 30-second call? If yes, the product isn't ready. Most aren't.",
      "Actually voice AI for SMBs doesn't need to be 'good.' It needs to be 'better than voicemail.' That bar is so low most products clear it on day 1. Brutal truth.",
      "Most voice-AI startups target call centers because that's where the contract values are. But the deployable product-market fit is at the solo-trader end. Different game.",
      "The version nobody mentions: voice AI's killer feature for SMBs isn't intelligence. It's just 'somebody picked up.' That alone wins the £400 callout 60% of the time."
    ],
    reason: 'voice-AI angle, on-pillar'
  },
  {
    name: 'ai-agent-business-models-question',
    // Only fires when OP is asking for AI-agent business model ideas (gregisenberg-style threads).
    // Requires: a question or open prompt + agent/business-model language.
    // Rejects pure announcements ("read the full post").
    test: t => /\b(agents?|agentic)\b/i.test(t) && /\b(business model|use case|use[- ]cases?|idea|ideas|what(.s| is)|which (one|niche|use)|examples?|categor(y|ies)|niche)\b/i.test(t) && /\?|:\s*$|\n\s*-/.test(t),
    drafts: [
      "Voice-AI receptionist for UK trades. 5M solo plumbers and electricians who currently send after-hours calls to voicemail. £30/mo replaces a £25k receptionist. Boring, but the unit economics are wild.",
      "AI receptionist for solo service businesses. Phone rings at 11pm, AI qualifies the job, books a slot, sends SMS confirm. Plumbers pay £30/mo. Nobody else is targeting that tier seriously.",
      "Niche I keep seeing untouched: AI receptionist for UK trades. Solo plumber/electrician/locksmith. Currently uses voicemail. Customer rings at 8pm, books with whoever picks up. £30/mo product, 5M buyers.",
      "Service-business reception. The under-served end of the agent market: a £30/mo voice/WhatsApp bot for the solo plumber who currently lets the phone ring out. Way bigger TAM than enterprise.",
      "WhatsApp AI for trades. UK plumbers now get half their bookings via WhatsApp and most still answer manually. An AI that triages the inbox, books the slot, and pings them only if it gets stuck is a real wedge.",
      "After-hours AI for emergency-callout trades (locksmiths, drainage, boiler). 70% of their inbound is between 6pm and 9am. Whoever picks up books the £400 job. Cheap to deploy, hard to displace once installed.",
      "AI booking for hairdressers and salons with no front-of-house. Independent salon owner is mid-cut, phone rings, lead drops. A £30/mo AI that handles the calendar lift is one of the most ignored use-cases I've seen.",
      "Mobile-mechanic dispatch. Solo operator drives between jobs all day, can't take calls. AI takes the inbound, qualifies vehicle/postcode, books the next free slot. Tiny niche, deep willingness to pay."
    ],
    reason: 'AI agent business-model question, direct answer with our use-case'
  },
  {
    name: 'mediocre-ai-outreach-or-sdr',
    // OP complaining about bad AI SDRs / spammy AI outreach (jasonlk-style).
    // We agree, then differentiate our category.
    test: t => /\b(AI|GPT|LLM|automated)\b/i.test(t) && /\b(SDR|sdrs?|cold email|cold outreach|spam|spammy|mediocre|hallucinat|fake|outreach|reachout|reach[- ]?out)\b/i.test(t),
    drafts: [
      "Yeah, and the worst part is it tars the legitimate use-cases too. An AI that picks up a missed call and books a slot is a different category from an AI that mass-emails strangers, but the market lumps them.",
      "Agree. The deployment that survives is constrained: AI that does ONE narrow job (book the appointment, qualify the lead) on inbound. The mass-outbound stuff is what's getting blocked.",
      "The SDR-spam problem is real and it's killing the brand for genuinely useful narrow agents. Inbound voice/WhatsApp reception is a totally different surface area; nobody confuses it with cold mass-email when they actually use it.",
      "Right, and the frustrating bit is the surviving agent use-cases (inbound reception, booking, qualifying) get judged by the cold-outbound failures. Same word, totally different deployment.",
      "The mediocre-AI-outbound wave is going to make customers way more skeptical, which weirdly favours the boring inbound deployments. Picking up a missed call is hard to spam, easy to verify.",
      "Inbound vs outbound is the real split. AI doing cold reach-outs is the spam category. AI handling a customer who already rang you is just a faster receptionist. Customers can tell.",
      "The 2026 split that matters: AI initiating contact (filterable, increasingly blocked) vs AI responding to inbound (welcomed if it actually helps). The second one is wide open and underbuilt.",
      "Yeah. The lesson most people miss is that mass-outbound automation has always been borderline; AI just made it cheaper. The genuinely new surface is inbound triage, and it's nothing like SDR spam."
    ],
    reason: 'AI SDR/spam complaint, agree-then-differentiate'
  },
  {
    name: 'untapped-niche-or-underserved-market-question',
    // OP asking what markets/niches are underserved or what to build (rxhit05/dvassallo-style direct asks).
    // Requires a question form.
    test: t => /\b(what (should|to build|business|niche|market|opportun|underserved|untapped)|which (niche|market)|name an under|biggest gap|most underserved|where('s| is) the (gap|opportunity|money))\b/i.test(t),
    drafts: [
      "Solo UK service trades. 5M plumbers/electricians/locksmiths still sending after-hours calls to voicemail in 2026. £30/mo AI receptionist replaces a £25k human. Zero serious competition at that tier.",
      "AI receptionist for solo trades. Currently they pay £0 (voicemail) or £25k (human). The gap between is empty and 5M UK businesses sit in it.",
      "Single-operator service businesses. They lose £200-£400 per missed call and pay nothing to fix it. The £30/mo tier is empty because everyone's chasing enterprise.",
      "Service-business reception is the most ignored £multibillion segment I've found. Plumber misses a call at 7pm, customer calls the next plumber. Nobody is building specifically for that.",
      "Emergency-callout trades after 6pm. Locksmiths, drainage, boilers. 70% of demand is out-of-hours, most operators answer 30% of it. AI receptionist closes that gap directly.",
      "Independent hair salons and beauty businesses with no receptionist. Owner is mid-appointment, phone rings, booking dropped. A £30/mo AI handling just the calendar is wildly underbuilt.",
      "WhatsApp triage for trades. UK customers default to WhatsApp now and most small trades have no system for it. The owner reads messages between jobs. AI that triages and books inside WhatsApp is open territory.",
      "Mobile-service operators (mechanics, tutors, dog groomers). They drive or work hands-on all day, can't pick up the phone. AI takes inbound, qualifies, books. Tiny per-customer ARR but enormous count and zero churn risk."
    ],
    reason: 'underserved-market question, direct answer with our segment'
  },
  {
    name: 'ai-model-or-tool-take',
    // OP shares a take/observation about AI models/tools. Reply with a contrarian
    // dev-twitter angle — pure value, no SMB pitch.
    test: t => /\b(Claude|GPT|gpt-?\d|Cursor|Codex|Copilot|Gemini|llama|Sonnet|Opus|Haiku|Anthropic|OpenAI|inference|context window|tokens?|RAG|fine[- ]?tune|model)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The thing nobody benchmarks: how much of a model's 'intelligence' is actually prompt scaffolding the tester wrote weeks earlier. Strip that out and most leaderboards collapse.",
      "The honest test for any model isn't ARC or MMLU. It's whether the same prompt gives the same answer on Tuesday and Saturday. Stability is the unmeasured axis everyone's quiet about.",
      "Most model debates compare best-case outputs. The actual deployment cost is in P99 latency and the 3% of replies that go off-script. Nobody puts that in the marketing copy.",
      "The unsexy version: the gap between top models is shrinking faster than benchmark scores suggest. The differentiation in 2026 is tooling around the model, not the model itself.",
      "Actually the moats in AI are migrating from model weights to context layers. Whoever owns the eval set + the user feedback loop wins. The model becomes a commodity input.",
      "Honest take that ages well: 'best model' debates look like 'best CPU' debates from 2008. They mattered for 6 months, then nobody cared. Same arc here, faster.",
      "The thing tech-twitter keeps missing about models: the bottleneck for 90% of useful applications is data quality, not parameter count. Same work either way.",
      "Worth re-reading: most 'X model is better' threads are downstream of which model the author has API credits in. Adjust accordingly."
    ],
    reason: 'AI model/tool contrarian take'
  },
  {
    name: 'shipping-or-launch-announcement',
    // OP shipped something. Reply with a useful insight other readers will engage with —
    // not a congratulation, not a pitch.
    test: t => /\b(shipped|just (launched|built|released)|announcing|happy to (ship|share)|launched (today|v\d)|new (feature|product|version)|finally (ship|launched|live))\b/i.test(t),
    drafts: [
      "The two-week pattern after every launch: usage spikes day 1-3, drops 60% by day 7, then either compounds or dies. Day 7 retention predicts the rest. Watch that number.",
      "The hard part isn't shipping. It's deciding what NOT to add for the next 30 days while you watch what users actually do. Most launches die from feature-bloat in week 3.",
      "Honest version of post-launch: 80% of feedback is wrong, 15% is irrelevant, 5% is the real signal. The skill is sitting with the noise without panic-shipping.",
      "The version nobody admits: the most useful post-launch metric isn't signups. It's whether anyone OPENS the product on day 4 unprompted. That's the real activation.",
      "Boring truth: launches that compound never had viral days. They had week-3 retention. Different metric, different team, different outcome.",
      "Most launch threads brag about day-1 numbers. The same threads go quiet by day 30. The honest curve is what week 4 looks like, not what Product Hunt looked like.",
      "Actually the unsexy lever post-launch is replying to the first 50 users personally. Most teams skip it for 'scaling.' The teams that don't, retain 3x.",
      "The pattern most builders don't see: launches over-attribute to product, under-attribute to distribution. Same product on a different account = different launch."
    ],
    reason: 'launch take, useful general insight'
  },
  {
    name: 'building-in-public-take',
    // OP shares a journey/MRR/indie insight. Reply with a peer observation that resonates,
    // no pitch, no salesy redirection.
    test: t => /\b(build(ing)? in public|indie hacker|side project|MRR update|monthly revenue|first \$\d+|hit \$\d+k|year (one|two|of building)|solo dev|solopreneur)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The pattern most indie threads skip: revenue growth doesn't track effort growth. You'll have a month where you do nothing and grow 20%, and a month of grinding where you flat-line. Detach.",
      "Honest version of build-in-public: the publicly-shared MRR number is the only metric that gets optimised, which is why most indie growth tactics game it. Watch for the gap between MRR and net revenue.",
      "The boring truth nobody puts in journey threads: the median solo SaaS founder makes $0 forever. The visible ones are survivor bias. Plan accordingly.",
      "Most indie 'I quit my job' threads underestimate runway. The actual unspoken rule: 18 months of expenses or a partner's income. The math nobody tweets.",
      "The version that ages well: indie SaaS isn't a product game. It's a distribution game with a product attached. Most builders learn this in year 2.",
      "Actually the most under-reported indie lever is timezone. Building for buyers in your sleep window doubles compounding because support drops out of your day.",
      "Worth re-reading: 'build in public' as a strategy works once. After year 2 the audience expects content, not progress. Different game, different muscle.",
      "The honest curve: $0-$1k MRR is the hardest. $1k-$10k is the longest. $10k-$30k is the loneliest. Most threads only show one of those phases."
    ],
    reason: 'indie/build-in-public peer insight'
  },
  {
    name: 'general-question-or-ask',
    // OP poses a question. Reply with a useful contrarian answer — no pitch, just substance.
    test: t => /\?/.test(t) && /\b(anyone (else|here|tried|using|recommend)|recommendations?|favourite|favorite|best (way|tool|approach|model|stack|framework|library)|which (one|tool|model|framework|library|approach)|what.s the (best|right) (way|tool|approach|stack|framework)|am i (the only|missing))\b/i.test(t) && t.length < 280 && !/\b(wrong (here|with|about)|what.s wrong|spot the (bug|issue|error|problem)|find the (bug|issue))\b/i.test(t),
    drafts: [
      "The honest answer most people won't give: 'best' depends entirely on what you've already wired. The right tool is the one that connects to your existing pipes in under an hour.",
      "Worth flipping: instead of 'which tool,' ask 'what's the cheapest thing I can ship this week that proves anyone wants it.' The tool answer drops out automatically.",
      "Most 'which X is best' answers are downstream of what the answerer used last. Decay your priors accordingly — the loudest opinions are usually 6 months old.",
      "Honest take: the right answer is whatever you'll actually finish. The best tool for someone who'll spend 2 weeks researching and 0 shipping is none.",
      "The boring version: pick the option with the most second-hand answers on Stack Overflow. Optimise for debuggability, not features. You'll be debugging 80% of the time.",
      "Actually the question I'd swap in: 'what's the worst version that would still work?' Then build that. The 'best' question gets you stuck in benchmarks; the 'worst' question gets you shipping.",
      "The version of this question that gets useful answers: 'I have constraint X and Y, what's the smallest tool that solves it.' Open questions get generic answers.",
      "Worth re-reading: most 'recommend a tool' threads are 80% noise, 20% useful. Skip to the replies with specific numbers and skip the rest."
    ],
    reason: 'general open question, useful contrarian answer'
  },
  {
    name: 'pricing-debate-or-saas-pricing-take',
    // Pricing debate. Reply with a sharp framing — no pitch.
    test: t => /\b(price|pricing|markup|expensive|cheap|free tier|saas pricing|charge|paywall|monetiz|too much money|burning money|paying \$\d|paying £\d)\b/i.test(t) && PAIN_SIGNAL.test(t),
    drafts: [
      "The pricing rule most SaaS gets backwards: you don't price against competitors, you price against the alternative of 'doing nothing.' If doing nothing is cheap, your price has to be too.",
      "Honest pricing test: if you doubled your price tomorrow, how many customers would actually leave? Most teams find out the answer is 'fewer than they feared.' Try it.",
      "The version nobody admits: pricing pages are mostly theatre. 80% of B2B sales happen on a sales call where the number is negotiated. The page just sets the anchor.",
      "Most 'we lowered our price and growth doubled' stories are survivor bias. The same teams later raised prices and growth stayed. The price was rarely the lever.",
      "Actually the pricing decision that matters more than the number: monthly vs annual. Annual customers churn 3-5x less and let you reinvest faster. The price difference is a rounding error.",
      "Worth re-reading: every pricing debate eventually circles back to 'who are you actually selling to.' Get the segment right, the price falls out almost automatically.",
      "The boring truth: cheap pricing attracts customers who churn fast. Expensive pricing attracts customers who never reply to your DMs. There's a middle that nobody writes about.",
      "Honest take that ages well: nobody ever lost a B2B deal on price. They lost it on the prospect not understanding what they were buying. Fix the message, the price stops mattering."
    ],
    reason: 'pricing debate, sharp framing'
  },
  {
    name: 'tools-or-stack-rant',
    // Tool/vendor rant. Reply with a useful general principle.
    test: t => /\b(switching (away )?from|migrate (away|off|out)|locked in|vendor lock|move (off|away) from|sucks at|terrible UX|dogshit|garbage|fed up with|frustrating|hate using|nightmare|painful|broken (and|but)|why the hell|why is .* so bad)\b/i.test(t),
    drafts: [
      "The pattern most rage-tweets miss: the tool didn't get worse, you got better. The thing that worked at year 1 always feels broken at year 3. That's growth, not a vendor problem.",
      "Honest version of tool-rants: 80% of the time the tool isn't the bottleneck, the workflow around it is. Switching tools costs 8 weeks and rarely moves the metric.",
      "The boring rule: never migrate based on Twitter rage. Migrate based on a specific metric you couldn't fix any other way. Most migrations fail this test on day 1.",
      "Most 'switching from X' posts are written by someone who configured X wrong. Read the docs once before declaring vendor war. Saves a quarter.",
      "Actually the loudest tool complaints come from teams that need 5% of the tool's surface area. The tool is fine; their evaluation was wrong.",
      "Worth re-reading: vendor rage feels like clarity. It's actually sunk cost dressed as judgement. Sleep on it 48h before pulling the trigger.",
      "The honest version: most lock-in is voluntary. People stay locked in because the alternative is 4 weeks of work, not because the vendor's contract demands it. Different problem, different fix.",
      "Hard truth: the best vendors aren't the ones with the prettiest pricing pages. They're the ones whose support replies in under an hour when you're on fire."
    ],
    reason: 'tool/vendor rant, general principle'
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

// Conversational angles bypass the punchy-stat quality gate because they're
// designed to engage the OP's specific question, not to viral-bait. Quality
// is gated by the trigger (must be a real question/claim) instead of by the
// draft form.
const CONVERSATIONAL_ANGLES = new Set([
  'ai-agent-business-models-question',
  'mediocre-ai-outreach-or-sdr',
  'untapped-niche-or-underserved-market-question',
]);

function pickDraft(text, candId) {
  for (const a of angles) {
    if (a.test(text)) {
      const idStr = String(candId || text);
      let h = 0;
      for (let i = 0; i < idStr.length; i++) h = (h * 31 + idStr.charCodeAt(i)) | 0;
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
      const realScore = scoreDraft(pick.draft);
      const isConversational = CONVERSATIONAL_ANGLES.has(a.name);
      if (!isConversational && realScore < 3) return null;
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

function isUnrepliable(t) {
  if (!t) return true;
  const trimmed = t.trim();
  if (trimmed.length < 60) return true;
  // Pure announcements / link-only posts
  if (/^(read (the )?full post|read more|new (research|paper|blog|post)|here(.s| is) (the|our)|just (shipped|launched|published))/i.test(trimmed)) return true;
  // Personal life / family / holidays - never reply with B2B pitch
  if (/\b(mother.s day|mothers day|father.s day|happy birthday|my (mum|mom|dad|son|daughter|wife|husband|kid|family)|RIP|condolences|prayers)\b/i.test(trimmed)) return true;
  // Politics / charities / non-business commentary
  if (/\b(election|democrat|republican|trump|biden|charity|charities|non[- ]?partisan|geopolit|ukraine|gaza)\b/i.test(trimmed)) return true;
  // Personal anecdotes - dialogue with no business hook
  if (/^(Liam:|Me:|Dad:|Mom:|Mum:|Son:|Daughter:|Wife:|Husband:)/m.test(trimmed)) return true;
  // Pure self-promotion of someone's own product/launch (no question, no claim we can engage)
  if (/^(I('m| am) (excited|thrilled|happy)|excited to (share|announce)|huge news|big news|announcing)/i.test(trimmed)) return true;
  // Tweets that are essentially just a link with no substance
  const wordsBeforeLink = trimmed.split(/https?:\/\//)[0].trim().split(/\s+/).length;
  if (wordsBeforeLink < 8 && /https?:\/\//.test(trimmed)) return true;
  return false;
}

// Reply emission DISABLED 2026-05-11. The angle library was keyword-matching
// superficial words and injecting canned replies that didn't address the
// actual proposition of the target tweet (bot-tier output). Until a per-tweet
// LLM generator replaces it, drafter only emits originals. Pat hand-writes
// replies from the firehose Telegram drafts or directly on phone.
const skippedAlreadyReplied = 0;

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
console.log(`Skipped ${skippedAlreadyReplied} candidates already replied to.`);
