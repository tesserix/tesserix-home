# Health Page Detail + Header Polish

**Goal:** the health page lists every workload and database individually, and
the header indicator reads as a control like the bell.

**Follows:** #333.

## Global Constraints

- **pnpm, not npm.** Console commands from `apps/console`; `packages/console-core`
  typechecks and builds separately (gitignored `dist/`). Do NOT `pnpm install`.
- **NO new Go dependencies**, **no new RBAC.** Everything added here comes from
  data `cluster.Reader` ALREADY fetches. Do not reach for `pods` — that verb is
  deliberately not granted.
- Wire `state` values stay exactly `healthy` / `degraded` / `unmeasured`.
- Commits: single-line conventional, no signature, no co-author trailer.

---

### Task 1 — carry the per-item detail through the Go module

`cluster.Reader` already returns `[]Workload{Name, Desired, Ready}` and
`[]Database{Name, Instances, Ready, Phase}`. `domain.Classify` reduces them to
`Counts` and discards the rest; `Database.Phase` has been decoded and asserted
in `cluster_test.go` since the first commit and read by nothing.

Add to `domain.Snapshot` the per-item lists, and put them on the wire:

```json
"workloads": { "total": 8, "ready": 8,
  "items": [ { "name": "console", "desired": 2, "ready": 2 } ] },
"databases": { "total": 1, "ready": 1,
  "items": [ { "name": "tesserix-postgres", "instances": 1, "ready": 1,
               "phase": "Cluster in healthy state" } ] }
```

**Consume `Phase` while you are here.** A CNPG cluster whose counts match but
whose phase is not the healthy one is not healthy — that is the deferred
finding from #332's review. Treat a non-healthy phase as a problem, and name
the phase in the reason. The healthy phase string in this estate is exactly
`"Cluster in healthy state"` (verified against prod). Do not invent a list of
bad phases; treat "not the healthy one" as the condition, which fails safe.

Ordering must be deterministic — sort by name — or the page reshuffles between
renders for no reason.

Tests: items survive `Classify`; a mismatched phase with matching counts is
degraded and the reason names the phase. **Ablation:** delete the phase check
and confirm that test fails.

---

### Task 2 — render the detail on the page

`apps/console/lib/health.ts`: parse the two `items` arrays. They are optional —
an older API answers without them, and the page must render exactly as it does
today in that case rather than throwing or showing an empty table. Follow the
module's existing rule: anything unparseable degrades, never throws.

`app/(console)/platform/health/page.tsx`: under "What was measured", render two
lists — one row per workload (name, `ready / desired`) and one per database
(name, `ready / instances`, phase). Mark rows that are short of their target
using the SAME vocabulary the state uses; do not invent a fourth colour.

Keep the existing summary counts as the heading of each list; they are the
at-a-glance number and the rows are the detail.

Tests: rows render; a short row is marked; absent `items` renders the page
unchanged (no empty table, no throw).

---

### Task 3 — the header control

`apps/console/components/nav/health-indicator.tsx`:

1. **Border it like the bell.** `notification-bell.tsx:185` is the reference:
   `rounded-md border border-border bg-background p-2 transition-colors
   hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring`. Match
   it so the two controls read as siblings; adjust padding for the wider
   content but keep the border, radius, hover and focus ring identical.
2. **Move the state dot to the RIGHT of the label.** Order becomes: icon,
   label, dot. Keep `(stale)` after the dot.

**Do not lose:** `role="status"` on the inner span (not the anchor), the full
`aria-label`, `aria-current="page"`, the state name in text, and the three
distinct SHAPES — filled circle / rotated diamond / hollow ring. The shapes are
load-bearing below `sm` where the label is hidden. A restyle must not flatten
them, and no test can catch it (jsdom has no viewport).

Test the DOM order — dot AFTER label — or the move is unpinned.
