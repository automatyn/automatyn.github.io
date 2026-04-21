#!/usr/bin/env node
// End-to-end bot smoke test. Drives the real OpenClaw agent via the CLI
// with scripted customer messages. No WhatsApp required.
//
// Usage:
//   node test-bot.js [agent-id]
//   AGENT_ID=biz-pats-plumbing-3ecf7b node test-bot.js
//
// Default agent: biz-pats-plumbing-3ecf7b (the dog-walking test business).

const { spawn } = require('child_process');

const AGENT_ID = process.argv[2] || process.env.AGENT_ID || 'biz-pats-plumbing-3ecf7b';
const TEST_NUMBER = '+447700900001'; // UK Ofcom TV drama range — never rings anyone real
const TIMEOUT_MS = 120000;

// Branding plugin appends the Automatyn footer once per conversation.
// For the branding scenario we use a fresh number so it's "first message"
// in a new conversation and the footer is expected to appear.
const BRANDING_TEST_NUMBER = '+447700900099';

// Scenarios a real customer might send. Each has what we expect.
const SCENARIOS = [
  {
    name: 'opening hours question',
    message: 'Hi, what are your opening hours?',
    expectContains: ['mon', 'fri'],
  },
  {
    name: 'service + price enquiry',
    message: 'How much is a dog walk?',
    expectContains: ['20', '$'],
  },
  {
    name: 'booking intent',
    message: "I'd like to book a dog walk for Saturday at 10am. Name's Sarah.",
    expectContains: null, // AI decides wording — just check non-empty + polite
  },
  {
    name: 'out-of-scope (plumbing — business is actually dog grooming)',
    message: 'Do you unblock drains?',
    expectContains: null,
  },
  {
    name: 'services listing',
    message: 'What services do you offer?',
    expectContains: ['dog'],
  },
  // Branding footer is not testable via the CLI: the `automatyn-branding`
  // plugin fires on the `message_sending` hook, which runs only when the
  // gateway actually delivers a message to WhatsApp. The CLI returns the
  // reply to stdout without going through the delivery pipeline, so the
  // footer never appears here. Verify branding manually via a real
  // WhatsApp message to a paired free-tier agent.
];

function runAgent(message, to = TEST_NUMBER) {
  return new Promise((resolve, reject) => {
    const args = [
      'agent',
      '--agent', AGENT_ID,
      '--channel', 'whatsapp',
      '--to', to,
      '--message', message,
      '--json',
    ];
    const child = spawn('openclaw', args, { timeout: TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`openclaw exited ${code}: ${stderr.slice(0, 400)}`));
      const start = stdout.indexOf('{');
      if (start < 0) return reject(new Error('no JSON in output'));
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch (e) {
        reject(new Error(`bad JSON: ${e.message}`));
      }
    });
    child.on('error', reject);
  });
}

function extractReply(result) {
  // payloads is where the outbound message sits
  const payloads = result?.result?.payloads;
  if (Array.isArray(payloads)) {
    const texts = payloads.map(p => p.text || p.content || '').filter(Boolean);
    if (texts.length) return texts.join('\n\n');
  }
  // Fallback: walk the object for any big string
  let best = '';
  const walk = (o) => {
    if (!o) return;
    if (typeof o === 'string' && o.length > best.length && o.length > 20) best = o;
    else if (Array.isArray(o)) o.forEach(walk);
    else if (typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(result);
  return best;
}

function green(s) { return '\x1b[32m' + s + '\x1b[0m'; }
function red(s)   { return '\x1b[31m' + s + '\x1b[0m'; }
function yellow(s){ return '\x1b[33m' + s + '\x1b[0m'; }
function gray(s)  { return '\x1b[90m' + s + '\x1b[0m'; }

async function main() {
  console.log(`\nBot smoke test — agent: ${AGENT_ID}\n`);
  const results = [];
  for (const s of SCENARIOS) {
    process.stdout.write(gray(`→ ${s.name}... `));
    try {
      const res = await runAgent(s.message, s.checkBranding ? BRANDING_TEST_NUMBER : TEST_NUMBER);
      const reply = extractReply(res);
      const pass = checkScenario(s, reply);
      results.push({ ...s, reply, ...pass });
      if (pass.ok) console.log(green('PASS'));
      else console.log(red('FAIL') + ' ' + pass.reason);
      console.log(gray(`  Q: ${s.message}`));
      console.log(gray(`  A: ${reply.slice(0, 240).replace(/\n/g, ' ')}${reply.length > 240 ? '…' : ''}`));
      console.log();
      // Light pacing — avoid hammering Gemini rate limit
      await new Promise(r => setTimeout(r, 4000));
    } catch (err) {
      console.log(red('ERROR') + ' ' + err.message);
      results.push({ ...s, ok: false, reason: err.message });
    }
  }
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  console.log('\n' + (passed === total ? green : yellow)(`Summary: ${passed}/${total} passed\n`));
  process.exit(passed === total ? 0 : 1);
}

function checkScenario(s, reply) {
  if (!reply || reply.length < 5) return { ok: false, reason: 'empty reply' };
  if (/rate limit|quota|unavailable/i.test(reply)) {
    return { ok: false, reason: 'model rate-limited — re-run later' };
  }
  if (s.expectContains) {
    const lower = reply.toLowerCase();
    const missing = s.expectContains.filter(t => !lower.includes(t.toLowerCase()));
    if (missing.length) return { ok: false, reason: `missing ${JSON.stringify(missing)}` };
  }
  if (s.checkBranding) {
    // Branding footer should appear for free-tier agents.
    // From memory: "AI agent by Automatyn" in italic on free tier.
    if (!/Automatyn/i.test(reply)) {
      return { ok: false, reason: 'no Automatyn branding footer on free-tier reply' };
    }
  }
  return { ok: true };
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(2); });
