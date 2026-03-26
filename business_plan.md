# Automatyn Business Plan

## What We Do
Professional OpenClaw setup and configuration service. We install, configure, secure, and deploy OpenClaw for businesses across Telegram, Discord, Slack, WhatsApp, and 20+ messaging platforms.

## Website
- **Live:** https://automatyn.github.io
- **Google Search Console:** Verified + sitemap submitted (2026-03-25)

## Pricing (competitive positioning)

| Tier | Price | What's included |
|---|---|---|
| Starter | $400 | Installation, 1 channel, basic security, 14-day support |
| Pro (most popular) | $800 | 3 channels, custom agent + skills, security hardening, 30-day support |
| Business | $1,500 | Unlimited channels, custom integrations, Docker sandboxing, 90-day support, onboarding call |
| Monthly Support | $150/mo | Updates, troubleshooting, priority response, 1x 30-min remote session |

## Competitive Landscape

| Competitor | Starter Price | Notes |
|---|---|---|
| SetupOpenClaw.sh | $3,000 | Premium, managed + hardware |
| OpenClawRUs | $2,000 | Setup + repair |
| OpenClaw Expert | $499 | Fast 24h setup |
| MyClaw | $599 | Mac-focused, $299/mo support |
| **Automatyn** | **$400** | Lowest entry, same-day setup |

## USP / Differentiation
- **Radical transparency:** show exact process, total cost of ownership, no hidden fees
- **Lowest entry point** in the market at $400
- **Free audit via email** -- lower friction than competitors who only offer calls
- **Monthly support at $150/mo** undercuts MyClaw ($299/mo) with same features

## Delivery Workflow
1. Client shares screen or SSH access
2. Claude Code handles installation, configuration, security, testing
3. We supervise and deliver -- typical setup: 1-2 hours (Starter), 2-3 hours (Pro)
4. Monthly support: client reports issue, we troubleshoot via Claude Code

## TikTok Content Pipeline (NataliaAI)

### Architecture
```
Telegram Bot (Gemini Flash) ──► Research trending hooks
                               ──► Send hooks to shared folder
                                         │
Claude Code ◄─────────────────────────────┘
  ├─ Call Forge API (local GPU via Tailscale)
  ├─ Generate 6-slide sequences (896x1152, ~2s/image)
  ├─ Self-review images, regenerate if needed
  ├─ Save to shared folder
  │
Telegram Bot ◄─── picks up images
  ├─ Add TikTok-optimized text overlays (Larry skill)
  ├─ Post to TikTok via Postiz API
  ├─ Track metrics
  └─ Suggest new hooks ──► repeat

```

### Image Generation Setup
- **Forge:** Running on laptop via Tailscale (100.107.24.7:7860)
- **Model:** JuggernautXL Ragnarok (SDXL, photorealistic)
- **Resolution:** 896x1152 (TikTok portrait, ~2s per image)
- **Style:** POV iPhone 15 Pro shots, feminine hand, lifestyle aesthetic

### Quality Control
- Option 1 + locked prompt templates
- Self-review each image before marking as ready
- Generate multiple variations for key slides, pick best
- Avoid: hand gestures (deformation risk), text on screens (gibberish)

## Progress Log

### 2026-03-25
- Website fully redesigned: Satoshi font, gradient wordmark, dark theme
- Removed fake testimonials, replaced with honest copy
- Added free email audit CTA
- Competitive pricing set: $400 / $800 / $1,500
- SEO overhaul: keyword-optimized meta, sitemap, robots.txt
- Repo renamed to automatyn.github.io (root domain for SEO)
- Google Search Console verified + sitemap submitted
- Tested full TikTok slide generation pipeline via Forge
- Generated 6-slide carousel with self-review process
- Designed split workflow: Telegram bot (research/overlay/metrics) + Claude Code (image gen)

## Next Steps
- [ ] Get first client (Reddit, OpenClaw Discord, community posts)
- [ ] Record first setup as proof/demo
- [ ] Add real testimonial to website
- [ ] Build automated cron pipeline for TikTok posting
- [ ] Create locked prompt template library for consistent image quality
- [ ] Write Medium article: "How to Set Up OpenClaw on Telegram"
- [ ] Get custom domain when budget allows
