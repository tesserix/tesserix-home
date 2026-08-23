# A health indicator in the console header

**Status:** approved — no open decisions. The five design decisions below were
settled with Mahesh in a brainstorming session; the one risky unknown (RBAC)
was spiked read-only against prod before this was written.
**Follows:** #324 (`c932ffb`), deployed.
**Goal:** every operator, on every console page, can tell at a glance whether
the estate is healthy, degraded, or *not currently being measured* — and the
third is never rendered as the first.

## Why now, and what this is really for

The console's sidebar has a Health group with five entries — `platform.uptime`,
`serviceHealth`, `observability`, `databases`, `customDomains`. All five are
`pending: true`: placeholders rendered as disabled spans with a "soon" badge.
The console can currently tell an operator nothing about whether anything is
up.

The estate has also just demonstrated, twice in two days, that its own
documentation is not a reliable description of its runtime. `CLAUDE.md` claims
Knative with scale-to-zero (there are zero Knative services and eight plain
Deployments) and GKE Autopilot (it is a Standard cluster with spot nodes). A
health signal read from the cluster itself is worth more here than usual,
precisely because the written description of this estate keeps being wrong.

**This phase is K8s ground truth plus the header indicator.** Prometheus
restart trends and the outbox signal are later phases, each additive. They are
out of scope.

## Decisions

### D1. One live indicator, not the five Health rail entries promoted

The header gets a single indicator. The five Health rail entries stay exactly
where they are, still pending.

Moving five unbuilt placeholders into the header would fill the most valuable
strip of the UI with controls that do nothing. The rail is the right place for
"this surface is coming"; the header is the right place for "here is a fact
about right now". One is an inventory, the other is a signal.

### D2. Three states — `healthy`, `degraded`, `unmeasured` — and the third is the point

`unmeasured` must be visually distinct from `healthy`. Not a paler green: a
different treatment that cannot be mistaken for "fine".

This is the decision the rest of the design exists to protect, and the estate
has already written down why, twice, in code that predates this work:

- `apps/console/lib/triage.ts` warns that a parked Prometheus answers `200`
  with `available: false`, so keying off the status code alone "would render a
  parked plane as healthy".
- `platform-api/internal/modules/tools/tools.go` refuses to carry a status
  column for the same reason — "a tile rendering green because nothing
  measured it".

A two-state indicator is not a simpler version of this feature. It is the
failure mode this feature exists to avoid.

`apps/console/lib/triage.ts` already contains `triageState()`, a three-valued
classifier over exactly this shape (`error` / `available === false` / ready),
and it is rendered by nothing today. **Read it before designing the wire
shape** — the console-side model may already be most of what is needed. Note
its `instrumentation-unavailable` state is the same idea as `unmeasured` under
a different name; pick one name and use it on both sides rather than
translating at the seam.

### D3. A Go module reads it. No `apps/web` paths.

The signal is served by a new module in `platform-api`, following
`internal/modules/tools/` exactly: kernel-only imports, a `RouteTable` as the
single declaration of routes, and a capability test that ranges over that table
and fails on an entry it has no case for.

`apps/web` already exposes `service-health`, `cnpg-health` and `outbox` admin
endpoints, and the console has a live path to them. **They are off limits.**
`apps/web` is the app being retired; building a new console surface on top of
it would add a reason to keep it.

### D4. Read the cluster, not only Prometheus

The module reads the Kubernetes API directly: **Deployment readiness** and
**CNPG `Cluster` status**.

The existing `apps/web` check aggregates pod readiness *via Prometheus* — one
hop from the truth, and blind exactly when Prometheus is parked, which is the
case D2 exists to handle. Deployment `status.readyReplicas` versus
`status.replicas` is the ground truth, and it is available from the API server
whether or not anything is scraping.

CNPG is included because the databases are the failure that matters most and
the least visible: `clusters.postgresql.cnpg.io` is a normal namespaced CRD
with a status the API server will hand over for the same read.

### D5. Cached ~15s, stale is labelled, and stale expires

The module caches the computed result for ~15 seconds. On a failed read it
serves the last good value **marked stale**. Past a hard ceiling (~60s) it
stops serving the cached value and returns `unmeasured`.

The header renders on every page for every operator, so an uncached read would
put a Kubernetes API call in the critical path of every navigation. That is the
reason for the cache.

The ceiling is the reason the cache is safe. Serving a stale green forever is
the same lie as rendering a parked plane as healthy — just in slower motion.
The staleness must reach the wire (and the UI), not be swallowed at the seam.

## The RBAC grant

**This is the first thing in the estate to hold cluster-read credentials.** It
gets its own section because of that, not because it is large.

### What was established by the spike

Probed read-only against prod. Nothing was created.

| Fact | Value |
| --- | --- |
| Cluster | `tesseract-prod-in-gke`, **Standard, not Autopilot** (nodes carry `cloud.google.com/gke-provisioning: spot`) |
| ServiceAccount | `platform-api` in namespace `tesserix` |
| Its RBAC today | **none** — `kubectl auth can-i list deployments -n tesserix --as=system:serviceaccount:tesserix:platform-api` → `no` |
| CNPG resource | `clusters.postgresql.cnpg.io`, a normal namespaced CRD |
| Admin can create Roles/RoleBindings | yes |
| Token already mounted | yes — `automountServiceAccountToken: true` in the chart |

Because the cluster is Standard, Autopilot's RBAC restrictions — the main
worry going in — do not apply at all.

### The grant

A namespace-scoped **`Role` + `RoleBinding` in `tesserix`**. Not a ClusterRole.

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["postgresql.cnpg.io"]
    resources: ["clusters"]
    verbs: ["get", "list", "watch"]
```

Everything the module reads lives in `tesserix`. A ClusterRole would grant
reads across every namespace in a cluster that also hosts unrelated estates,
in exchange for nothing this phase needs. If a later phase genuinely needs
cross-namespace reads, widening a Role to a ClusterRole is a visible, reviewable
change; starting wide means no one ever notices it was never narrowed.

`pods` is included alongside `deployments` because a Deployment reporting
`readyReplicas: 0` cannot say *why*, and the pod phase is the difference
between "crash-looping" and "unschedulable". If the first implementation does
not use it, **drop it from the Role** rather than granting it speculatively.

### Where it goes, and who applies it

It belongs in **`tesserix-k8s`**, as a new
`charts/apps/platform-api/templates/rbac.yaml`, beside the existing
`serviceaccount.yaml`. It must be behind a values flag (`clusterRead.enabled`,
default `false`) so the chart can be installed without the grant and so
enabling it is an explicit, greppable line in the ArgoCD Application rather
than an implicit consequence of a chart bump.

**A human applies this to prod.** Not an agent, not a plan step that runs
`kubectl`. The plan may write the manifest and the values flag; granting
cluster-read credentials in production is a review-and-apply step Mahesh does.
The plan must state this explicitly at the point it becomes relevant, the way
the tools work stated that migration `0031` was applied by hand before its PR
merged.

Order matters, and it is the reverse of the usual one: **the grant must exist
in the cluster before the module that needs it is deployed.** A module shipped
first answers `unmeasured` for every operator until someone remembers the
manifest — which is indistinguishable, from the UI, from the failure it is
meant to report.

## What this must not do

### It must not gate on `platform`

`GET /v1/platform/health` is gated on **`read`**, not `platform`.

The header renders on every page for every operator. Gating this on `platform`
gives a `crm`-only operator a 403, which the indicator can only render as
`unmeasured` — telling them the estate is unmeasured when the truth is that
they are not authorised. That is not a degraded signal; it is a false one.

**This exact defect (C1) was found and fixed on the tools API hours before this
was written** — the two GET routes were moved from `platform` to `read` for
precisely this reason. Do not reintroduce it one endpoint over.

### It must not audit from the console

No writes exist in this phase, so nothing should be writing an audit row at
all. The rule is recorded here because the moment a write appears, the
estate's shape is: `write.Perform` records the audit row inside the transaction
that did the work, and a console-side `auditedOperation` on top of it produces
two rows for one action — the second able to survive a rollback of the first.

### It must not invent a second error classifier

The console already has two, `lib/db-read-error.ts` and
`components/kit/surface-state.ts`, and the rule for choosing between them is at
the head of `lib/crm-queues.ts`: re-classify at the seam when the refusal has an
existing console-vocabulary equivalent; extend the central classifier only when
the condition is genuinely new. "The cluster read failed" is genuinely new.
"The API refused us" is not.

## Verification this design demands

The estate has a specific, earned distrust of green test suites, and this
design inherits it.

- **A green suite proves nothing was changed, not that anything is protected.**
  On the last branch, six tests passed for a reason other than the one they
  named — a field mapping nothing asserted, an action wired to the wrong
  function, a guard whose test passed with the guard deleted, positional
  `getAllByRole(...)[0]` selectors, a fixture blind to a global-index bug, and
  one that actively pinned wrong behaviour. Every one was found by deleting or
  moving the thing the test claimed to protect. **Do that deliberately here**,
  and in particular:
  - delete the staleness ceiling and confirm a test fails;
  - force the cluster read to fail and confirm the indicator goes `unmeasured`,
    not `healthy`;
  - change the capability gate from `read` to `platform` and confirm a test
    fails.
- **`tsc` is not a build, and a build is not a typecheck.** Run `typecheck` in
  **both** `apps/console` and `packages/console-core`, plus `test:unit`, `lint`,
  and `build`. All five. Three separate CI failures in one session came from
  local verification not covering what CI runs.
- **`packages/console-core` ships via a gitignored `dist/`.** Changing `src/`
  without `npm run build` there means the console type-checks against stale
  types.
- **Database tests skip silently** without `TESSERIX_TEST_DB_HOST`. Confirm
  zero skips rather than reading a pass.
- **Fixtures use non-contiguous numbers** (10, 20, 30) wherever position or
  order is involved, so an implementation deriving a value from an array index
  fails instead of passing by coincidence.

## Prior art to read first

- `apps/console/lib/triage.ts` — the three-state classifier, already written,
  rendered by nothing.
- `platform-api/internal/modules/tools/` — the module shape to copy, including
  `RouteTable` and the capability test that fails on an uncovered route.
- `apps/console/components/nav/console-header.tsx` — where the indicator
  mounts, beside `NotificationBell` and `OperatorMenu`.
- `docs/superpowers/specs/2026-08-22-console-tools-management-surface-design.md`
  and its plan — the most recent worked example of the spec → plan →
  subagent-driven flow in this repo.
