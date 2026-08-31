# Secrets Backend Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the secrets backend from the `tesserix/secret-service` repository into `tesserix-home` as its own deployable, changing nothing about what it does.

**Architecture:** The Go API becomes `secrets-api/` beside `platform-api/`, added to `go.work`, built by its own Dockerfile into its own image, and deployed as its own workload with its own service account — deliberately NOT a module inside the platform-api process, because it holds a GitHub credential able to write across `tesserix-k8s`, OpenBao write access and cluster RBAC. Behaviour, configuration and auth are unchanged in this plan; the image tag moves from `:latest` to a pinned `main-<sha7>`.

**Tech Stack:** Go 1.26.5, Gin, `go.work`, Docker multi-stage → distroless, GitHub Actions, Helm chart in `tesserix-k8s`, Kargo promotion, ArgoCD.

**Spec:** `docs/superpowers/specs/2026-08-31-console-secrets-absorption-design.md`

## Global Constraints

- Go **1.26.5** exactly — `go.work` pins it and a mismatched `go.mod` fails the workspace build.
- This repo is **pnpm**; `npm ci` FAILS (no `package-lock.json`). Go work here is unaffected but do not run npm.
- The backend **stays a separate process**. Do not import it from `platform-api`, and do not add it to `platform-api/go.mod`.
- **No behaviour change in this plan.** Auth stays Google OAuth + `ADMIN_EMAILS`; the Zitadel swap is a later plan. A diff that changes a handler's response is out of scope.
- **The new deployment must use a pinned `main-<sha7>` tag**, never `:latest` (#468). `imagePullPolicy` follows the platform-api chart.
- Commit messages: single line, conventional commits, **no body, no signature**.
- Migrations are manual in this estate and deploys are not — this plan adds no migration, and must not.

---

### Task 1: Vendor the Go module into the repository

**Files:**
- Create: `secrets-api/` (the contents of `secret-service/apps/api/`, moved verbatim)
- Modify: `secrets-api/go.mod:1`
- Modify: `go.work:3`

**Interfaces:**
- Consumes: nothing.
- Produces: a buildable module at `github.com/tesserix/tesserix-home/secrets-api`, entrypoint `./cmd/server`, packages `api`, `audit`, `auth`, `bao`, `config`, `gcpsm`, `gitops`, `k8s`, `secrets`.

- [ ] **Step 1: Copy the module in, preserving structure**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
cp -R ../secret-service/apps/api ./secrets-api
rm -rf secrets-api/.git
ls secrets-api/internal
# expect: api audit auth bao config gcpsm gitops k8s secrets
```

- [ ] **Step 2: Rename the module path**

Edit `secrets-api/go.mod` line 1 from:

```
module github.com/tesserix/secret-service/api
```

to:

```
module github.com/tesserix/tesserix-home/secrets-api
```

Then rewrite every internal import:

```bash
cd secrets-api
grep -rl "github.com/tesserix/secret-service/api" --include='*.go' . \
  | xargs sed -i '' 's|github.com/tesserix/secret-service/api|github.com/tesserix/tesserix-home/secrets-api|g'
grep -rc "secret-service/api" --include='*.go' . | grep -v ':0' || echo "no stale imports"
```

- [ ] **Step 3: Add it to the workspace**

Edit `go.work` so it reads:

```
go 1.26.5

use ./platform-api
use ./secrets-api
```

- [ ] **Step 4: Verify it builds and its tests pass, unchanged**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home/secrets-api
go build ./... && go vet ./... && go test -race -count=1 ./... 2>&1 | tee /tmp/relocate.log
grep -c "^FAIL" /tmp/relocate.log
```

Expected: build and vet silent; `grep -c "^FAIL"` prints `0`; ten packages report `ok`. This is the whole gate for this task — the code is unchanged, so the test suite must be identical to the one that passed in the old repository.

- [ ] **Step 5: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
git add go.work secrets-api
git commit -m "feat(secrets-api): vendor the secrets backend into this repository (#274)"
```

---

### Task 2: Build it as its own image

**Files:**
- Create: `Dockerfile.secrets-api`
- Read for reference: `Dockerfile.platform-api`

**Interfaces:**
- Consumes: the module from Task 1.
- Produces: an image whose entrypoint is `/app/server`, listening on `PORT` (default 8080).

- [ ] **Step 1: Write the Dockerfile**

Mirror `Dockerfile.platform-api`'s shape — a `golang:1.26-alpine` builder and a `gcr.io/distroless/static-debian12:nonroot` runtime. Distroless is deliberate: it has no shell, which is why the runbook tells operators to mint a token rather than `kubectl exec` into these pods.

```dockerfile
FROM golang:1.26-alpine AS builder
WORKDIR /src

COPY secrets-api/go.mod secrets-api/go.sum ./
RUN go mod download

COPY secrets-api/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=builder --chown=nonroot:nonroot /out/server /app/server
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app/server"]
```

- [ ] **Step 2: Build it and confirm the binary runs**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
docker build -f Dockerfile.secrets-api -t secrets-api:plan-test .
docker run --rm secrets-api:plan-test --help 2>&1 | head -3 || true
```

Expected: the build succeeds. The `--help` line may error — the binary does not necessarily take flags — but it must not fail with "exec format error" or "no such file", which would mean the binary did not land at `/app/server`.

- [ ] **Step 3: Confirm the image has no shell**

```bash
docker run --rm --entrypoint sh secrets-api:plan-test -c 'echo reachable' 2>&1 | head -2
```

Expected: it fails. A shell in this image would be a regression against the distroless property the estate relies on.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile.secrets-api
git commit -m "feat(secrets-api): build the secrets backend as its own image (#274)"
```

---

### Task 3: Give it its own CI workflow

**Files:**
- Create: `.github/workflows/secrets-api.yml`
- Read for reference: `.github/workflows/platform-api.yml`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a workflow publishing `main-<sha7>` on pushes to `main` that touch `secrets-api/**`.

- [ ] **Step 1: Write the workflow**

Copy `.github/workflows/platform-api.yml` and change the paths, job names and image name. Two things to carry over deliberately:

- The **path filter** (`secrets-api/**`, `go.work`, `Dockerfile.secrets-api`, and the workflow itself). `platform-api.yml`'s own comment records why an over-narrow filter is a bug: a change outside the filter that breaks a test lands on `main` with nothing to catch it.
- The **postgres service is NOT needed** — unlike platform-api, this module's tests do not use `testdb`. Verified: `grep -rl testcontainers secrets-api` returns nothing. Do not copy the service block; a service nothing connects to is noise.

The test step must be `go test -race -count=1 ./...` from `secrets-api/`, matching what the old repository ran.

- [ ] **Step 2: Validate the workflow parses**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-home
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/secrets-api.yml')); print('yaml ok')"
```

Expected: `yaml ok`.

- [ ] **Step 3: Confirm the path filter actually covers the module**

```bash
grep -A8 "paths:" .github/workflows/secrets-api.yml | grep -c "secrets-api"
```

Expected: at least `2` (push and pull_request filters).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/secrets-api.yml
git commit -m "feat(secrets-api): build and publish the secrets backend image on main (#274)"
```

---

### Task 4: Chart the new workload in tesserix-k8s

**Files:**
- Create: `charts/apps/secrets-api/Chart.yaml`, `values.yaml`, `values-prod.yaml`, `templates/` — in the **`tesserix-k8s` repository**, not this one
- Read for reference: `charts/apps/platform-api/`
- Read for reference: the live deployment, `kubectl -n secret-service get deploy secret-service-api -o yaml`

**Interfaces:**
- Consumes: the image from Task 3.
- Produces: a deployment named `secrets-api` in the `tesserix` namespace, with its own ServiceAccount.

- [ ] **Step 1: Capture the live configuration to port**

```bash
kubectl -n secret-service get deploy secret-service-api -o yaml > /tmp/old-secrets-api.yaml
kubectl -n secret-service get sa secret-service-api -o yaml > /tmp/old-secrets-sa.yaml
grep -E "name: (ENVIRONMENT|PORT|APP_BASE_URL|ALLOWED_ORIGINS|SESSION_TTL|ADMIN_EMAILS|SECRET_BACKENDS|SECRET_BACKEND_DEFAULT|GCP_PROJECT_ID|OPENBAO_|GITHUB_)" -A1 /tmp/old-secrets-api.yaml
```

Every one of those variables must appear in the new chart. Omitting one changes behaviour, which this plan forbids.

- [ ] **Step 2: Write the chart, pinned not floating**

Model it on `charts/apps/platform-api/`. Three things that must be right:

- `image.tag` is a **pinned `main-<sha7>`**, never `:latest`. The old deployment used `:latest` with `imagePullPolicy: Always`, which is #468 — two pods could run different commits with nothing to show it.
- The ServiceAccount carries the **same GCP Workload Identity annotation** as the old one (`iam.gke.io/gcp-service-account: secret-service@tesseracthub-480811.iam.gserviceaccount.com`), or the pod loses `secretManagerWriteBlind` and every Google Secret Manager call fails.
- An **ExternalSecret** supplying `GITHUB_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_KEY`. These live in a plain Kubernetes Secret today (`secret-service/secret-service-api`) rather than GCP Secret Manager; port them to an ExternalSecret so they match the rest of the estate, and record in the chart comment that the GitHub token is a personal PAT pending #464.

- [ ] **Step 3: Render it and check the variables survived**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
helm template secrets-api charts/apps/secrets-api \
  -f charts/apps/secrets-api/values.yaml \
  -f charts/apps/global-config-prod.yaml \
  -f charts/apps/secrets-api/values-prod.yaml > /tmp/rendered.yaml
grep -c "name: OPENBAO_ADDR\|name: SECRET_BACKENDS\|name: GITHUB_OWNER" /tmp/rendered.yaml
grep -c ":latest" /tmp/rendered.yaml
grep -c "iam.gke.io/gcp-service-account" /tmp/rendered.yaml
```

Expected: the first prints `3` or more; the second prints `0`; the third prints `1`.

- [ ] **Step 4: Bump the chart version**

`ct lint` requires a version bump on every chart change and fails the build without one — this cost a CI round on tesserix-k8s#775. A new chart starts at `0.1.0`.

- [ ] **Step 5: Commit**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
git add charts/apps/secrets-api
git commit -m "feat(secrets-api): chart the relocated secrets backend with a pinned image tag (tesserix-home#274)"
```

---

### Task 5: Run both old and new side by side, and compare

**Files:**
- Modify: `charts/apps/secrets-api/values-prod.yaml` (replicas) in `tesserix-k8s`

**Interfaces:**
- Consumes: Task 4.
- Produces: evidence that the relocated service behaves identically before anything is switched over.

This task exists because the plan's premise — "changing nothing about what it does" — is a claim, and an unverified claim is how this estate acquires its bugs. The old workload keeps serving throughout.

- [ ] **Step 1: Deploy the new workload alongside the old**

Merge Task 4's chart PR, then wait for the pods:

```bash
kubectl -n tesserix rollout status deploy/secrets-api --timeout=5m
kubectl -n tesserix get pods -l app.kubernetes.io/name=secrets-api \
  -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{end}'
```

Expected: pods Running on a `main-<sha7>` tag. If ArgoCD reports `Synced` while the pods still show an old tag, read the Application's revision — `Synced` describes the last reconcile, not the current commit.

- [ ] **Step 2: Compare health and backends between old and new**

```bash
kubectl -n tesserix port-forward deploy/secrets-api 18200:8080 &
sleep 3
curl -s -o /dev/null -w "new /healthz: %{http_code}\n" http://127.0.0.1:18200/healthz
curl -s http://127.0.0.1:18200/api/backends | python3 -m json.tool
kill %1
```

Expected: `200`, and `backends` listing `openbao` and `gcpsm` with default `openbao` — identical to the old service's answer. A different backend list means the environment did not port cleanly.

- [ ] **Step 3: Confirm the Google Secret Manager path still works**

```bash
kubectl -n tesserix logs deploy/secrets-api --since=5m | grep -iE "gcpsm|secret manager|permission" | head -5
```

Expected: no permission errors. A `PermissionDenied` here means the ServiceAccount lost its Workload Identity annotation — Task 4 Step 2.

- [ ] **Step 4: Record the comparison in the PR, then commit nothing**

This task produces evidence, not code. Paste the three outputs above into the Task 4 PR before it is merged into the retirement sequence.

---

### Task 6: Point traffic at the new workload

**Files:**
- Modify: the Istio VirtualService for `secret-service.tesserix.app`, in `tesserix-k8s`

**Interfaces:**
- Consumes: Task 5's evidence.
- Produces: the existing hostname served by the relocated workload.

- [ ] **Step 1: Find what routes the hostname today**

```bash
cd /Users/Mahesh.Sangawar/personal/tesserix-new/tesserix-k8s
grep -rn "secret-service" --include='*.yaml' charts/ k8s/ 2>/dev/null | grep -iE "virtualservice|host" | head -5
kubectl get virtualservice -A 2>/dev/null | grep -i secret
```

- [ ] **Step 2: Repoint the backend route to `secrets-api.tesserix.svc.cluster.local`**

Change only the destination host and port. Leave the hostname, TLS and gateway alone — this plan moves where the traffic lands, not how it arrives.

- [ ] **Step 3: Verify from outside the cluster**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://secret-service.tesserix.app/healthz
```

Expected: `200`, served now by `secrets-api`. Confirm which pod answered:

```bash
kubectl -n tesserix logs deploy/secrets-api --since=2m | tail -3
```

- [ ] **Step 4: Scale the old workload to zero, but do not delete it**

```bash
kubectl -n secret-service scale deploy/secret-service-api --replicas=0
```

Zero rather than deleted: if anything regresses, scaling back is one command, whereas recreating a deleted deployment means finding its manifest in a repository that is about to be archived. Deletion happens in the retirement plan, once the console UI has replaced the old front end.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(secrets-api): serve secret-service.tesserix.app from the relocated backend (tesserix-home#274)"
```

---

## Self-Review

**Spec coverage.** This plan implements §1's "the backend stays its own deployable… same repository" and nothing else — deliberately. §3 (authorisation), §5–§7 (the flow, the stores, writing a value), §8 (notifications) and §9 (security properties) belong to plans 2–4, which cannot start until the module has a home. §9's properties are preserved rather than implemented here, because no handler changes.

**Dependencies not resolved by this plan.** #464 (the personal PAT with `admin` on `tesserix-k8s`) travels with the code and becomes more pressing once it lives in a shared repository — Task 4 Step 2 records it in the chart rather than fixing it. #465 (the undeclared IAM role) is untouched; the relocated workload depends on that role exactly as the old one did.

**What this plan fixes incidentally.** #468, for this workload: the new deployment is pinned to `main-<sha7>` rather than `:latest`.

**Type consistency.** The module path `github.com/tesserix/tesserix-home/secrets-api` is used identically in Task 1 Steps 2 and 3, the Dockerfile's `COPY secrets-api/`, and the workflow's path filter. The workload name `secrets-api` is used identically in Tasks 4, 5 and 6.
