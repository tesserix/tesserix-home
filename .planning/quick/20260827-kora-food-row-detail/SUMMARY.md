---
slug: kora-food-row-detail
date: 2026-08-27
status: complete
---

# Kora food rows: expandable detail + pager placement parity

## What shipped

**Expandable food rows.** A food's label is now a `<button>` with
`aria-expanded`/`aria-controls`; activating it renders a second `TableRow`
(`colSpan={2}`) showing Record id, Source and Type. Expansion state is a
`ReadonlySet<string>` replaced on every toggle, never mutated.

**Pager placement.** `ResultPager` moved above the table on both Kora
surfaces, matching `platform/crm/queue-view.tsx` and
`platform/crm/organisations/organisations-view.tsx`. All four index surfaces
now read FilterBar → ResultPager → Table → scope note.

## Why a disclosure and not a detail route

There is no get-one endpoint at any layer. The console reads foods through
`GET /v1/entities/{type}` (`lib/platform-api.ts`), platform-api registers that
list pattern only (`entities/internal/handler/handler.go`), and kora serves
`/admin/entities/{type}` with no by-id sibling. So `EntityRecord` — six fields —
is the whole record the console can ever hold, and a `/kora/foods/[id]` route
would be a URL with nothing behind it. Three of those six were already on the
row; the disclosure shows the other three without implying a page that does
not exist.

## Known, accepted

`aria-controls` references an id that is absent while the row is collapsed,
because the detail row is not rendered until expanded. This is the APG
disclosure pattern and screen readers handle it, but a strict a11y linter will
flag the unresolved IDREF. The alternative puts every food's id in the
accessibility tree permanently; the dangling reference was judged the better
trade.

## Not done

- Any get-one endpoint. That is a contract gap, sibling to #365, and belongs to
  the session that owns kora. Nothing was filed there.
- `/kora/foods/[id]` as a route.
- The same disclosure on `kora/users` — the request was foods. A test asserts
  users rows have no disclosure, so the boundary is not silently crossable.
- No operator has watched this render. Verified by tests, DOM order assertions
  and `next build`; not by loading the page.
