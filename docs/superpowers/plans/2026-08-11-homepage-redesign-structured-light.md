# Tesserix Homepage Redesign — "Structured Light" (Concept B) Implementation Brief

**Date:** 2026-08-11
**Status:** Approved direction — locked by Mahesh
**Approved mockup:** https://claude.ai/code/artifact/5bbfb3d9-6c44-4fc8-a44c-1449a3737a5a (label `b-final-bold-tesseract`)
**Rejected alternatives:** Concept A "Dark Glass & Aurora" (pattern-matches AI-generated aesthetics), Concept C "Hybrid" (inherits A's hero tells)
**Scope:** `apps/web` marketing surface — homepage first, then propagate tokens to other marketing pages.

---

## 1. Design rationale (context for reviewers)

The current homepage scored 25/40 on a design critique. Root causes: palette literally copied from Stripe/Linear/Vercel (`globals.css` comment says so), Geist fonts, template hero formula (badge pill → headline → stat row), zero product imagery, and decorative devices (marquee, numbered eyebrows, dot grids) with no brand meaning.

The approved direction: **bright cool-white "engineering blueprint" precision**. Restraint IS the brand argument — Tesserix's pitch is "specialized, honest, humans reply," so the design proves it with structure instead of atmosphere. This direction was explicitly chosen as the least "AI-generated-looking" of the three explored.

**Hard constraints from Mahesh (do not violate):**
- **No purple/violet/magenta anywhere** — "purple screams AI".
- **No bright-blue flashing/strobing accents** — the tesseract uses steady deep cobalt only.
- Use the **real logo** (`public/logo.png`), never a stand-in mark.
- **No street address in the footer** — company name + ACN/ABN + © only. Address lives on /contact.
- Real product screenshots — never AI-generated fake UI.
- Existing copy voice stays (it survived the critique untouched).

## 2. Token system (replaces the current `:root` in `apps/web/app/globals.css`)

```css
--paper:        #f5f7fa;   /* page ground — cool white, never pure white, never cream */
--paper-2:      #eef1f6;   /* recessed surfaces: browser bars, wells */
--card:         #ffffff;   /* raised cards */
--ink:          #0b0e14;   /* primary text, ink panels, primary buttons */
--ink-2:        #3d434f;   /* body text on paper */
--ink-3:        #6f7686;   /* muted text — AA at small sizes, do not go lighter */
--line:         rgba(11,14,20,0.10);  /* hairlines */
--line-strong:  rgba(11,14,20,0.20);  /* section-opening rules */
--cobalt:       #2e5cff;   /* THE accent: links, kickers, focus, hover borders */
--cobalt-deep:  #1f3fd4;   /* tesseract near-edges, pressed states */
--live:         #12a374;   /* live status only (green = live, nothing else) */
--warning-chip: #925d0e on #fdeed7;  /* e.g. "Packing" chips inside product UI */
```

- Dark tokens survive ONLY inside the CTA ink panel and dark UI previews (`#0b0e14` ground, `#f0f3f9` text, `#aab2c2` muted).
- Blueprint grid: 72px × 72px, `rgba(11,14,20,0.028)` 1px lines, masked to fade at top/bottom of the body. Fixed/absolute background layer, `pointer-events: none`.
- **Kill entirely:** all slate hex values, the "Stripe / Linear / Vercel inspired" block, dot-grid textures, `animate-marquee`.

## 3. Typography

- **Kill Geist.** Sans: `-apple-system, "SF Pro Display", "SF Pro Text", "Segoe UI Variable", "Segoe UI", system-ui` (or license a comparable modern grotesk later — decision deferred, not blocking).
- Mono (`SF Mono, ui-monospace, Menlo`) ONLY for real data: kickers, status labels, ETAs, ABN/ACN, email address. Never decorative numbering.
- Display scale: hero `clamp(2.8rem, 7vw, 5.8rem)`, weight 650, letter-spacing −0.048em, line-height 0.99, `text-wrap: balance`, max-width ~14ch.
- Section h2: `clamp(2rem, 4.6vw, 3.4rem)`, −0.04em.
- Kicker pattern: 2.2rem cobalt rule + mono uppercase label (replaces the old `01 —` numbered eyebrows).
- One accent word per display block max (`<em>` in cobalt, no gradient text).

## 4. Page structure (homepage `(marketing)/page.tsx`)

1. **Nav** — solid light bar, hairline bottom border, real logo (un-inverted), 3 links, ink button "Talk to us" (hover → cobalt).
2. **Hero** — left: kicker line, display headline ("people" in cobalt `<em>`), sub, ink + outline buttons; right: **the tesseract canvas** (see §5). Below: hairline-top meta row with live-status dots (green) for Mark8ly/Fe3dr. **No stat row. No badge pill. No marquee.**
3. **Product ledger** — `border-top: line-strong`, then one full-width hairline row per live product: left = name + Live pill + tagline + links; right = large framed screenshot (browser frame for Mark8ly, dark dual-phone panel for Fe3dr — the dark panel popping against white is intentional). Row hover lifts the frame 4px.
4. **Coming-soon cluster** — three compact white cards (Dwellm8, MediCare, Kora), hover border → cobalt, mono ETA line. Visibly quieter than live rows.
5. **Studio statement** — the existing paragraph as a large display blockquote, one cobalt `<em>` phrase, mono attribution. Keep `ScrollRevealStatement` word-reveal if desired (it fits), else static.
6. **Principles** — three columns separated by hairlines (not cards), cobalt mono num-line, existing copy.
7. **CTA** — inverted ink panel, radial cobalt glow top-right, the **glass tesseract render** masked on the right, white button. This is the page's single dark moment.
8. **Footer** — light, real logo, product/company links, legal line **without address**: `Tesserix Pty Ltd · ACN 694 070 865 · ABN 59 694 070 865 · © 2026 Tesserix`.

## 5. Signature element — the engraved tesseract (hero canvas)

4D hypercube (16 vertices, 32 edges) rotating in the XW + YZ planes with slow XZ drift, projected 4D→3D→2D. Full reference implementation lives in the approved mockup's `<script>` — port as a client component (`components/marketing/tesseract.tsx`).

Locked drawing rules ("engraving rule"):
- Perspective: `wd = 3.4/(3.4−w)`, `zd = 4.6/(4.6−z)`, scale `min(W,H) × 0.135`.
- Depth factor `tt` drives everything: far edges 0.8px `rgba(11,14,20,0.18)` → near edges up to 2.3px at 0.68 alpha.
- Nearest edges (`tt > 0.72`): steady **deep cobalt `#1f3fd4`**, up to 2.8px. **No sweeps, no flashing, no gradients.**
- Vertices: ink dots, cobalt when nearest.
- Rotation speeds: 0.22 / 0.15 / 0.04 rad·s⁻¹. `devicePixelRatio` capped at 2. `prefers-reduced-motion`: render one static frame (t≈16s pose).
- Canvas `aria-hidden`, ~46vw wide, right side of hero, `opacity` reduced + pushed off-canvas on mobile.

## 6. Motion system

- Load: single `rise` choreography (opacity + 24px translateY, 0.9s `cubic-bezier(0.22,1,0.36,1)`, staggered delays 0.05–0.46s). **Animate via a `loaded` class added on mount — elements must be visible without JS** (see §8 fix).
- Scroll: IntersectionObserver reveal (threshold 0.12), one-shot.
- Hover: frame lift (4px translateY + shadow), border → cobalt, button lift. Nothing else.
- Everything gated on `prefers-reduced-motion`.

## 7. Real product screenshots (replaces stylized stand-ins)

Capture list (light-mode, clean demo data, no PII):
1. Mark8ly admin — orders list view, browser-framed, ~1280×800 (ledger row 1).
2. Mark8ly storefront — a real merchant or polished demo store (product detail page reuse).
3. Fe3dr customer app — home/browse screen, ~390×844 (dual-phone panel, left).
4. Fe3dr cook app — order queue screen (dual-phone panel, right).
5. Per coming-soon product later: one teaser frame when each enters beta.

Serve via `next/image`, real frames drawn in CSS (browser chrome / phone bezel components) so shadows and radii stay consistent.

## 8. Pre-existing P1 bugs to fix during the rebuild (apply regardless)

1. **Content invisible before hydration** — current `hero.tsx` uses framer-motion `initial="hidden"`; first paint is a blank page (verified: blank viewport screenshot on load). New pattern: server-render visible, add `loaded` class client-side to run the entrance, or gate `initial` on a mounted flag.
2. **Hero scroll-out collides with marquee** — moot once the marquee is deleted, but do not reintroduce transform-on-scroll over adjacent sections.

## 9. Accessibility gate (verified on mockup, keep in build)

- Landmarks + labelled navs; canvas and decorative images `aria-hidden`.
- Visible cobalt focus ring on every interactive element (`outline: 2px`, offset 3px).
- Contrast: `--ink-2` on paper ≈ 10:1; `--ink-3` ≈ 4.6:1 — **do not lighten `--ink-3`**; cobalt on paper ≈ 4.8:1 (fine at link sizes/weight 600).
- Full reduced-motion support; page fully legible with JS off.
- Status never encoded by color alone (dot + text label always).

## 10. OG / social image

Redesign `apps/web/app/opengraph-image.tsx` in this language: paper ground, faint blueprint grid, ink display type, cobalt tesseract line-art, real wordmark. Built in code (crisp text) — not AI-generated.

## 11. Brand assets (already generated, reusable)

Higgsfield glass-tesseract renders (2K, 16:9, mint/cyan/azure palette — pre-date the cobalt decision; fine inside the dark CTA panel):
- In use (CTA): `hf_20260811_074725_2d650b6f-7c46-4754-936f-0540c4791c4e.png`
- Spare (marketing/social): `hf_20260811_074725_f1176a94-7b40-49ab-92c1-d1ef29ec984f.png`
- Both in the user's Higgsfield library (job IDs `2d650b6f…`, `f1176a94…`); re-download and commit compressed copies (≤100KB JPEG) to `public/` when implementing.
- Future (post-launch, separate task): social/launch kit — banners, per-product card backdrops, logo-reveal video.

## 12. Suggested build order

1. Tokens + fonts in `globals.css` (single PR — visual base).
2. `Tesseract` canvas component.
3. Hero rebuild (includes P1 hydration fix).
4. Product ledger + coming-soon cluster (data still from `products-data.ts`).
5. Statement + principles + CTA + footer.
6. Screenshot capture + swap-in.
7. OG image. 8. Delete dead CSS (marquee keyframes, dot grids, slate tokens). 9. Re-run `/critique`.
