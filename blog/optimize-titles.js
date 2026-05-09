#!/usr/bin/env node
// Optimize blog titles for Google CTR.
// Rules:
//   1. Strip " | Automatyn" suffix from <title> (Google shows domain separately;
//      the suffix wastes 12 chars of the 60-char display window).
//   2. Shorten titles >60 chars by removing parenthetical year, redundant phrases.
//   3. Keep og:title + twitter:title with the original Automatyn suffix (those go
//      to social previews where the brand IS useful).
// Idempotent: if <title> already lacks the Automatyn suffix, skip it.

const fs = require('fs');
const path = require('path');

const NOINDEX = new Set([
  'passive-income-ai-agents-2026.html',
  'can-you-really-make-money-with-ai-2026.html',
  'how-much-does-ai-chatbot-cost-2026.html',
  'claude-managed-agents-vs-openclaw-2026.html',
  'claude-managed-agents-what-it-means-2026.html',
  'claude-code-getting-dumber-2026.html',
  'claude-code-vs-codex-2026.html',
  'index.html',
]);

const BLOG_DIR = __dirname;
const files = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.html') && !NOINDEX.has(f));

let updated = 0, skipped = 0, stillTooLong = 0;
const samples = [];

for (const file of files) {
  const fpath = path.join(BLOG_DIR, file);
  let html = fs.readFileSync(fpath, 'utf8');
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (!titleMatch) { skipped++; continue; }
  const orig = titleMatch[1].trim();

  // Step 1: strip " | Automatyn" or "| Automatyn" suffix
  let next = orig.replace(/\s*\|\s*Automatyn\s*$/i, '').trim();

  // Step 2: tighten common wordiness if still >60
  if (next.length > 60) {
    next = next
      .replace(/\s*\(2026\)\s*/g, ' ')
      .replace(/\s*Complete\s+/gi, ' ')
      .replace(/\s+The\s+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Step 3: still too long? Append " | Automatyn" only if shortcut keeps under 60. Otherwise leave as-is.
  if (next === orig) { skipped++; continue; }
  if (next.length > 60) stillTooLong++;

  // Replace title only (preserve og:title etc.)
  html = html.replace(/<title>[^<]+<\/title>/, `<title>${next}</title>`);
  fs.writeFileSync(fpath, html);
  updated++;
  if (samples.length < 8) samples.push({ file, before: orig, after: next, blen: orig.length, alen: next.length });
}

console.log(`updated: ${updated}, skipped (already optimal): ${skipped}, still over 60 after rewrite: ${stillTooLong}`);
console.log('\n=== samples ===');
for (const s of samples) {
  console.log(`  ${s.file}`);
  console.log(`    BEFORE [${s.blen}]: ${s.before}`);
  console.log(`    AFTER  [${s.alen}]: ${s.after}`);
}
