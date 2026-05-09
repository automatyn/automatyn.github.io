#!/usr/bin/env node
// Bulk-inject "Related reading" sections into all buyer-intent blogs.
// Builds a topical-authority cluster by adding 4 contextual internal links per blog.
//
// Strategy: for each blog, pick 4 related blogs based on URL keyword overlap.
// Skip if a "related-reading-injected" marker is already present (idempotent).

const fs = require('fs');
const path = require('path');

const BLOG_DIR = __dirname;
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

const MARKER = '<!-- related-reading-injected -->';

const allFiles = fs.readdirSync(BLOG_DIR).filter(f => f.endsWith('.html') && !NOINDEX.has(f));
console.log(`processing ${allFiles.length} buyer-intent blogs`);

// Load each blog's H1 title (for nicer link text)
function loadTitle(file) {
  try {
    const html = fs.readFileSync(path.join(BLOG_DIR, file), 'utf8');
    const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  } catch {}
  // Fallback: humanise the slug
  return file.replace(/\.html$/, '').replace(/-/g, ' ').replace(/2026/g, '').trim();
}

const blogs = allFiles.map(f => ({
  file: f,
  url: '/blog/' + f,
  title: loadTitle(f),
  // Tokenise URL slug for similarity matching
  tokens: new Set(f.replace('.html', '').split('-').filter(t => t.length > 2 && t !== '2026')),
}));

// For each blog, find the 4 most-related others by token overlap
function findRelated(b, k = 4) {
  return blogs
    .filter(x => x.file !== b.file)
    .map(x => {
      let overlap = 0;
      for (const t of b.tokens) if (x.tokens.has(t)) overlap++;
      return { ...x, overlap };
    })
    .sort((x, y) => y.overlap - x.overlap || Math.random() - 0.5) // random tie-break for variety
    .slice(0, k);
}

let injected = 0, skipped = 0, missing = 0;
for (const b of blogs) {
  const fpath = path.join(BLOG_DIR, b.file);
  let html = fs.readFileSync(fpath, 'utf8');
  if (html.includes(MARKER)) { skipped++; continue; }

  const related = findRelated(b);
  if (related.length === 0) continue;

  const block = `\n${MARKER}\n<section class="related-reading my-12 pt-8 border-t border-zinc-800">
  <h2 class="text-2xl font-bold mb-4 text-white">Related reading</h2>
  <ul class="space-y-2">\n${related.map(r => `    <li><a href="${r.url}" class="text-cyan-400 hover:text-cyan-300">${r.title}</a></li>`).join('\n')}\n  </ul>
</section>\n`;

  // Inject before </article>, fallback to before </main>, fallback to before </body>
  let placed = false;
  for (const anchor of ['</article>', '</main>', '</body>']) {
    if (html.includes(anchor)) {
      html = html.replace(anchor, block + anchor);
      placed = true;
      break;
    }
  }
  if (!placed) { missing++; continue; }
  fs.writeFileSync(fpath, html);
  injected++;
}
console.log(`injected: ${injected}, skipped (already present): ${skipped}, missing anchor: ${missing}`);
