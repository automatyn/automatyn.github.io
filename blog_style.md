# Automatyn Blog Style Guide

Always read this file before writing a new blog post. The reference template is `blog/missed-call-automation-uk-plumbers-2026.html` — when in doubt, copy from there.

---

## 1. Brand & Theme

- **Background**: `#030303` (near-black)
- **Cyan accent**: `#22d3ee` (`--neon-purple` variable, despite the name)
- **Electric blue**: `#67e8f9`
- **CTA green gradient**: `linear-gradient(180deg, #85e6b5 0%, #5dd492 100%)` with `color: #0a0a0a`
- **Inline-CTA button green**: `linear-gradient(135deg, #059669, #10b981)`
- **Body text**: `#a1a1aa` (zinc-400), 1.1rem, line-height 1.8
- **Headings**: `#ffffff`
- **Muted/meta**: `#71717a` / `#a1a1aa`

## 2. Typography

- **Body / UI**: `'DM Sans', sans-serif` — weights 400, 500, 700
- **Headings (H1–H6)**: `'Cabinet Grotesk', sans-serif` — weights 700, 800
- Load via:
  ```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="/dist/tailwind.css">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <link href="https://api.fontshare.com/v2/css?f[]=cabinet-grotesk@700;800&display=swap" rel="stylesheet">
  ```
- Apply with `!important` everywhere (see CSS block in reference template).

## 3. File Structure (mandatory order)

1. `<head>` — meta tags + OG + Twitter card + canonical
2. Three `<script type="application/ld+json">` blocks: **Article**, **BreadcrumbList**, **FAQPage**
3. `<style>` block (copy verbatim from reference template)
4. `<body class="antialiased">`
5. Reading progress bar `<div class="reading-progress" id="reading-progress" style="width: 0%;"></div>`
6. Urgency banner (fixed top, dot pulse + pricing link)
7. Fixed nav (`top-[36px]`, Automatyn logo, Blog/Pricing/Start Free)
8. `<header class="hero-gradient grid-bg pt-24 pb-16">` containing:
   - Breadcrumb (`Home / Blog / <crumb>`)
   - Badge pill (cyan, e.g. "Trade Playbook", "Diagnostic", "FAQ")
   - H1 with `<span class="gradient-text">…</span>` highlight
   - Subhead `<p class="text-lg text-zinc-400">`
   - Author block (round gradient avatar "A" + "Automatyn Team" + date · Xmin read)
9. Hero image: `<picture>` with WEBP source + JPG fallback, 1344x768, rounded-xl, cyan border
10. `<main class="max-w-3xl mx-auto px-4 sm:px-6 py-12">` → `<article class="prose">`
11. Inside article (in this order):
    - TOC card (`card-glow rounded-xl p-5 mb-10 toc`) listing anchored sections
    - Body sections: numbered `<h2 id="…">N. Title</h2>` + paragraphs/lists
    - **At least one** `<div class="inline-cta">` mid-article (after section 2 or 3)
    - `<h2>The Bottom Line</h2>` closing section with internal link to a related blog post
    - Big CTA button: `<div class="text-center my-12"><a href="/signup.html" class="cta-button px-8 py-4 text-base">…</a></div>`
    - `<h2 id="faq">Frequently Asked Questions</h2>` followed by 5 `<h3>+<p>` Q/A pairs (mirror the FAQPage JSON-LD exactly)
12. Author bio card (round avatar + 1-line description + "Learn more about Automatyn." link)
13. Footer (Automatyn logo + Home/Blog/Pricing + © 2026)
14. Mobile sticky CTA (`<div class="mobile-sticky-cta">` → "Start Free →")
15. Reading progress `<script>` at end of `<body>`

## 4. Required Layout Elements (the 6-point checklist)

Every editorial post MUST have:
1. Breadcrumb (Home / Blog / <crumb>)
2. Badge pill above H1
3. Gradient H1 (one phrase wrapped in `<span class="gradient-text">`)
4. Author block with avatar + date + read-time
5. TOC card listing anchored sections
6. Author bio card at the end

This applies to **editorial posts only**. Never retrofit programmatic location pages.

## 5. Content Length & Structure

- **Word count**: 1500–4000 HTML words. The 2026-05-01 batch was ~3500–3700.
- **Read time**: 7–10 min typical.
- **Sections**: 5–7 numbered H2s + a "The Bottom Line" closer.
- **Each H2** has an `id` matching its TOC anchor.
- **Paragraphs**: short (2–4 sentences). Use `<strong>` to bold the load-bearing phrase, not for SEO stuffing.
- **Lists**: prefer over walls of text where ≥3 items.
- **Blockquote** allowed once for an external statistic.
- **External links**: open Harvard Business Review, ONS, similar — not aggregators.
- **Internal links**: at least one to another `/blog/…` post + at least one to `/pricing.html`.

## 6. Voice & Tone

- **Founder-grade, no AI-bro**. Sounds like a UK SMB veteran who knows the trade.
- **British English**: "organisation", "favour", "behaviour", postcodes (SE, HU, S6).
- **Concrete examples** (Leeds, Bradford, M62, Saturday morning emergency).
- **Numbers**: write small numbers as words ("five seconds", "thirty percent"); large figures as digits ("£1,500", "£28,000").
- **Currency**: write GBP figures as illustrative ranges only. **Never hardcode Automatyn pricing — link to `/pricing.html`** (we use geo-pricing).

## 7. Hard Content Rules (CLAUDE.md)

- **NEVER** use em dashes or hyphens between clauses. Use a full stop or comma.
- **NEVER** use: `leverage`, `unlock`, `seamless`, `game-changer`, `revolutionary`, `cutting-edge`, `streamline`, `empower`, `synergy`, `optimize`, `disrupt`.
- **NEVER** use words: `bot`, `chatbot`, `receptionist` for our product UI text. Use `agent` (the noun "AI receptionist" is OK as an SEO keyword in titles/H1/H2 only).
- **NO fake prices**. Real prices: `$400 / $800 / $1500` one-time + `$150/mo` support — but in blog body, link to `/pricing.html`.
- **Skip the founder section** (no "About me, the founder…").

## 8. SEO / Metadata

- `<title>`: `<H1 phrasing> | Automatyn` (≤ 65 chars where possible)
- `<meta name="description">`: 150–170 chars, distinct from subhead
- `<meta name="keywords">`: 5 phrase-match keywords
- Canonical: `https://automatyn.co/blog/<slug>.html`
- OG + Twitter: same title/desc, image = absolute URL to hero JPG
- Three JSON-LD blocks: Article, BreadcrumbList, FAQPage (copy structure from reference)
- `datePublished` + `dateModified` = ISO date
- Slug: lowercase, hyphenated, ends with `-YYYY` for the year

## 9. Hero Images

- **Generator**: Forge Stable Diffusion at `http://100.107.24.7:7860/sdapi/v1/txt2img`, model **JuggernautXL**.
- **Dimensions**: 1344x768.
- **Output**: JPG (~100–200KB) + WEBP (~40–80KB) at `blog/images/<heroSlug>.{jpg,webp}`.
- **Picture tag**:
  ```html
  <picture>
    <source srcset="images/<heroSlug>.webp" type="image/webp">
    <img src="images/<heroSlug>.jpg" alt="<heroAlt>" class="w-full h-56 sm:h-72 md:h-80 object-cover rounded-xl border border-cyan-500/20" loading="eager">
  </picture>
  ```
- **Theme rule**: dark, moody, cyan accent visible somewhere (monitor glow, neon, sky, hi-vis). Match the `#22d3ee` palette.
- **Faceless preferred** — back of head, hands, over-shoulder. Generic stock-photo faces look off-brand.
- **Negative prompt** must include: `face, faces, person visible, head, suit, tie, banker, corporate office, watermark, text, logo, low quality, blurry`.
- **Audit before publish**: open the JPG, check (1) dimensions, (2) no face, (3) cyan accent visible, (4) on-brand mood. Regenerate if any of those fail. Show the user before committing.

## 10. Inline CTA Block

Drop one (sometimes two) into the article body, typically after section 2 or 3:

```html
<div class="inline-cta">
    <p class="text-white font-semibold text-lg mb-2" style="color: #ffffff;">[ONE-LINE HOOK].</p>
    <p class="text-zinc-300 text-sm mb-4">[ONE-LINE EXPANSION mentioning free starter / 10 min / no credit card].</p>
    <a href="/pricing.html" class="inline-flex items-center px-6 py-3 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity" style="background: linear-gradient(135deg, #059669, #10b981); color: #0a0a0a !important; text-decoration: none;">See pricing &rarr;</a>
</div>
```

## 11. FAQ Block (5 questions)

- 5 Q/A pairs, exactly mirroring the FAQPage JSON-LD entries.
- Render each as `<h3 class="text-xl font-bold mt-8 mb-2 text-white">Question?</h3><p>Answer.</p>`.
- Answers should be 2–4 sentences, give a real answer (not deflection).

## 12. Publishing Checklist (in order)

1. Write post HTML at `blog/<slug>.html` (use `/tmp/build-blog.js` if available, else copy from reference template).
2. Generate hero image via Forge → save JPG + WEBP at `blog/images/<heroSlug>.{jpg,webp}`.
3. Audit image (dimensions, faceless, on-brand cyan).
4. Insert new card as the **FIRST card** on `/blog/index.html`.
5. Replace the oldest of the 3 homepage blog cards on `/index.html` with the new post (latest 3 only on homepage).
6. Add URL to `sitemap.xml` with `<lastmod>` = today.
7. IndexNow ping:
   ```bash
   curl -s -X POST https://api.indexnow.org/indexnow \
     -H 'Content-Type: application/json' \
     -d '{"host":"automatyn.co","key":"33cde438cf539c1c8163bfc84005cab7590f53a89b32592714a7b035922f442f","keyLocation":"https://automatyn.co/33cde438cf539c1c8163bfc84005cab7590f53a89b32592714a7b035922f442f.txt","urlList":["https://automatyn.co/blog/<slug>.html","https://automatyn.co/blog/","https://automatyn.co/sitemap.xml"]}' \
     -w '\nHTTP %{http_code}\n'
   ```
8. Append to `social-posts/session-log.md` under `### /seo-daily — YYYY-MM-DD`.
9. `git add` ONLY the changed files (never `-A`). Commit + push.

## 13. Per-Post Data Object (for `build-blog.js`)

```json
{
  "title": "<H1 phrasing>",
  "slug": "<lowercase-hyphenated-with-year>",
  "metaDesc": "<150-170 chars>",
  "keywords": ["k1","k2","k3","k4","k5"],
  "heroSlug": "<image-filename-without-ext>",
  "heroAlt": "<descriptive alt text, no face>",
  "crumb": "<short breadcrumb label>",
  "badge": "<Trade Playbook | Diagnostic | FAQ | …>",
  "h1": "Title with <span class=\"gradient-text\">highlight</span>",
  "subhead": "<one-paragraph hook>",
  "banner": "<urgency banner phrase>",
  "date": "YYYY-MM-DD",
  "dateLong": "Month D, YYYY",
  "readMin": 7,
  "toc": [{"id":"section-id","label":"1. Section Label"}, …],
  "body": "<full HTML body with <h2 id> sections, lists, inline-cta blocks, internal links>",
  "faq": [{"q":"…","a":"…"}, … ×5]
}
```

## 14. Reference Files

- **Template HTML**: `blog/missed-call-automation-uk-plumbers-2026.html`
- **Builder**: `/tmp/build-blog.js` (if expired, regenerate from template)
- **Memory pointers**: `feedback_blog_template.md`, `feedback_blog_index_order.md`, `feedback_blog_geopricing.md`, `feedback_image_generation.md`, `feedback_image_audit_before_publish.md`
