# Console↔Stripe parity: a metric, and an alert (tesserix-home#579)

The catalog↔Stripe parity check writes a row and renders a badge. Nothing
alerts on it. A difference is visible only to a human who opens
`/platform/billing/catalog` — and this is the check that gates #327's
observation window and the Stripe write-key revocation.

Worse than silence: a DIFFERENT check also called "catalog parity" IS alerted
(`CatalogParityDifference` / `CatalogParityStale` on
`mark8ly_catalog_parity_*`), and it never touches Stripe — it compares
mark8ly's compiled fallback against what the console serves. An operator can
see those alerts working and conclude Stripe parity is covered. It is not.

## Verified before planning (2026-09-06, `origin/main` @ 2f0ab41)

- The console exposes **no metrics endpoint at all** — nothing under
  `app/api` serves Prometheus text format, and no `prom-client` dependency
  exists. This is not "add a metric"; it is the console's first metrics
  surface.
- The console Deployment carries **no `prometheus.io/*` annotations**, so it
  has never been a scrape target.
- **`tesserix` is deliberately `ambientExcluded`** (istio-config values):
  ztunnel drains on every ArgoCD reconcile of the namespace-wide
  AuthorizationPolicies caused 15–30s 503 bursts at the edge. So the console
  is NOT in the mesh, and a plaintext scrape needs no PeerAuthentication or
  AuthorizationPolicy work — unlike tesserix-k8s#1018, which is the trap this
  plan is deliberately avoiding.
- The console's NetworkPolicy **already permits ingress from `monitoring`**
  (`charts/apps/console/templates/network-policy.yaml`, commented "Prometheus
  scrape and Istio control plane"). Nothing to change there.
- `podAnnotations` is already a values-driven hook on the Deployment.
- The parity result is written by a CronJob, which cannot be scraped. The
  DATABASE is the only shared source of truth, and `readLatestRuns` /
  `readWindowStatus` already read it for the UI.

## Scope

Items 1 and 2 of the issue. Items 3 and 4 are deferred with reasons stated at
the bottom.

### T1 — a metrics endpoint on the console

`app/api/internal/metrics/route.ts`, Prometheus text exposition, computed from
`plan_catalog_parity_runs` via the existing repo reads.

Series, one sample per (mode, source) pair:

- `tesserix_console_stripe_parity_differences{mode,source}` — the last run's
  difference count
- `tesserix_console_stripe_parity_last_clean_timestamp_seconds{mode,source}` —
  when that pair last ran CLEAN, the staleness half
- `tesserix_console_stripe_parity_window_satisfied` — #327's gate as 0/1

**No operator session.** Prometheus cannot mint one. The endpoint is protected
by the NetworkPolicy (monitoring + istio-system only) and by exposing nothing
but counts and timestamps.

**It must never emit the stored `error` string.** That text is sanitized for an
operator reading one row on a page, not for a metrics endpoint whose output is
retained, indexed and widely readable. Numbers only; the reason stays on the
surface #591 put it on.

Done when: the endpoint returns valid exposition for every pair including a
pair that has never run, and a unit test pins the format and the absence of any
free-text label.

### T2 — make the console a scrape target

`podAnnotations` in `tesserix-k8s` (`charts/apps/console/values.yaml`):
`prometheus.io/scrape`, `port`, `path`.

Done when: the target appears in Prometheus and is `up`.

### T3 — alert on it, and end the name collision

New `k8s/cluster/prometheus/rules/console_stripe_parity.yaml`, mirroring
`catalog_parity.yaml`'s two-alert design and its reasoning:

- a difference alert, which is the finding
- a staleness alert, because a gauge describing the LAST run reads "fine"
  forever once the runner stops

Plus — per tesserix-k8s#1018's lesson — neither is trusted on silence alone;
`TargetDown` now covers the absent-series case for both.

The collision is resolved by NAMING, not by renaming mark8ly's deployed and
alerted metric: `tesserix_console_stripe_parity_*` says which two things are
compared. Both rule files get a comment pointing at the other, so a reader
landing on either knows the other exists and what it does NOT cover.

Done when: both rules load and evaluate against real series.

## Deferred, with reasons

- **Issue item 3** (test-mode reporting `clean` while publishing to test is
  impossible) — its stated premise is "while #540 stands". **#540 is CLOSED**
  (2026-09-05 18:59Z, the test-mode write key now exists and
  `values-prod.yaml` sets `stripeWriteKeyTest`). Whether the test publication
  is still frozen is now a question about DATA, not about a blocker — and the
  metric this plan adds is what will answer it. Re-file against evidence
  rather than implementing a "cannot verify" state for a condition that may no
  longer hold.
- **Issue item 4** (cross-account comparison) — the issue itself says
  "consider". It is a new comparison, not alerting on an existing one.

## Out of scope

- tesserix-home#594 (the re-run control can reset the window) — separate.
