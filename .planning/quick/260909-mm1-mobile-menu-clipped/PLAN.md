---
id: 260909-mm1
slug: mobile-menu-clipped
date: 2026-09-09
kind: quick
branch: fix/marketing-mobile-menu-clipped
---

# The marketing hamburger menu opens into the header's box, not the viewport

Reported from a phone on `tesserix.app`: tapping the hamburger swaps the icon
to an X and dims a small square at the top-left, but no menu appears. The
panel is not missing — it renders, clipped to the height of the header, so
only its own title row (logo + close button) is visible and the "PRODUCTS"
heading below is cut off mid-line.

## Cause

`apps/web/components/common/navbar.tsx` renders the overlay and the slide-in
panel as children of `<header>`, and that header carries `backdrop-blur`:

```
<header className="sticky top-0 z-50 … backdrop-blur supports-[backdrop-filter]:bg-background/60">
```

A `backdrop-filter` other than `none` makes the element a **containing block
for fixed-position descendants** (same rule as `filter`, `transform`, and
`will-change`). So inside that header:

- the panel's `fixed top-0 right-0 h-full` resolves against the ~73px header
  box, not the viewport — hence a 73px-tall menu;
- the overlay's `fixed inset-0` covers only the header — hence the small dim
  square rather than a full-page scrim.

Nothing is wrong with the state, the transition, or the z-indexes. Only the
containing block is wrong, and it is wrong solely because of where the two
elements sit in the tree.

Desktop is unaffected: the mega-menu dropdown is `absolute`, and an absolute
descendant of a positioned ancestor was always meant to resolve against it.

## Tasks

1. **Move the overlay and the panel out of `<header>`.** Return a fragment
   with the header and the two fixed elements as siblings. The panel keeps
   `z-50` and follows the header in DOM order, so it still paints above it;
   the overlay keeps `z-40`, above page content and below the panel. Record
   the containing-block reason in a comment beside the `backdrop-blur` class
   so the next person does not nest a fixed child back into it.

   Done when: on a 390px viewport with the menu open, the panel occupies the
   full viewport height and the scrim covers the whole page.

2. **Drop the `h-[calc(100%-73px)]` magic number** on the scrolling link
   list. 73px is the panel's own title row measured by hand; it is only
   correct while that row's padding and the logo height stay exactly as they
   are. Make the panel a flex column and let the list be `flex-1` with its
   own `overflow-y-auto`.

   Done when: the link list scrolls independently of the title row, with no
   hardcoded height anywhere in the panel.

## Verification

`pnpm --filter web build` from this checkout (not the primary one), plus a
390x844 render of `/` with the menu open.
