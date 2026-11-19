# Marketing content from Tesserix CMS

State as of 2026-11-19. Plan: `docs/superpowers/plans/2026-11-19-marketing-cms.md`.
Companion changes: tesserix-cms branch `feat/tesserix-tenant` (collections, migration, seed).

## How the site reads it

- `apps/web/lib/cms/client.ts` fetches `${CMS_URL}/api/<collection>?where[tenant.slug][equals]=tesserix&depth=1&limit=0&sort=order`
  anonymously, with a 5 s timeout (`CMS_TIMEOUT_MS`), a 60 s Next fetch cache tagged `cms` and
  `cms:<collection>`, and React `cache()` so each collection is fetched once per request.
- `lib/cms/products.ts` and `lib/cms/site.ts` map the Payload docs to the shapes in `lib/cms/types.ts`
  and expose `getProducts()`, `getProduct()`, `getTeam()`, `getPrinciples()`, `getBeliefs()`, `getOpenSource()`.
- Server components call the getters and pass plain props to the `"use client"` components.
  Client components never import the getters.
- Icons are stored as lucide names; `components/marketing/icon.tsx` renders them and holds the list
  the CMS offers (`ICONS`, mirrored in `tesserix-cms/src/collections/tesserix/icons.ts`).

## Fallback rule

Every getter is `orFallback(read, static)`. A `CmsError` (unreachable, non-2xx, timeout, bad body,
or `CMS_URL` unset) returns the frozen copy in `lib/cms/fallback/`. When `CMS_URL` is set the
failure is logged once per collection per request; when it is unset (local dev, Docker build) the
fallback is silent. Any other error propagates. The fallback is the site as it was on 2026-11-19;
it is not updated when content changes in the CMS.

Routes under `(marketing)`, `sitemap.xml` and `llms.txt` carry `export const revalidate = 60`,
because the Docker build has no CMS and would otherwise prerender them as permanently static.

## Publish webhook

`POST /api/revalidate` with header `x-cms-secret: $CMS_WEBHOOK_SECRET` and body
`{ "collection": "products" | "team-members" | "principles" | "beliefs" | "open-source-projects", "slug"?, "previousSlug"? }`
expires the tags `cms:<collection>` and `cms`, and revalidates `/products/<slug>` (and the old slug)
for products. The CMS fires it on publish, unpublish and delete (`tesserix-cms/src/hooks/revalidateSite.ts`).

## Environment

| Variable | Where | Value |
|---|---|---|
| `CMS_URL` | company chart `env` | `http://tesserix-cms.cms.svc.cluster.local` |
| `CMS_WEBHOOK_SECRET` | company ExternalSecret | OpenBao `tesserix-cms/app/tesserix-cms-tesserix-webhook-secret` |
| `CMS_TIMEOUT_MS` | optional | default 5000 |

Local dev without a CMS needs nothing: leave `CMS_URL` unset.

## Cluster handoff (not yet done)

The local wiring mirrors yes-hospital's (`tesserix-k8s`, see yes-hospital's `docs/cms-handover.md`).
In order:

1. **OpenBao secret.** Create `tesserix-cms/app/tesserix-cms-tesserix-webhook-secret` (key `value`,
   random hex is fine) at console.tesserix.app/platform/secrets.
2. **tesserix-k8s PR, OpenBao readers.** In `charts/thirdparty/openbao/values.yaml` add the new path to
   policy `read-tesserix-cms-production` (so the CMS seed Job can read it) and add a policy + role
   `read-tesserix-cms-tesserix-production` for service account `tesserix-cms-production-reader` in
   namespace `tesserix`, modelled on `read-tesserix-cms-yes-hospital-production`. Add the matching
   SecretStore/reader manifest for namespace `tesserix` next to
   `external-secrets/prod/tesserix-cms-openbao-readers.yaml`.
3. **tesserix-k8s PR, CMS side.**
   - `external-secrets/prod/cms/externalsecret.yaml`: add `tesserixWebhookSecret` from the new path and
     template it as `TESSERIX_WEBHOOK_SECRET`.
   - `charts/apps/tesserix-cms/templates/manual-jobs.yaml` + `values.yaml`: a `jobs.seedTesserix`
     block copied from `seedYesHospital`, script `seed:tesserix`, `SEED_WEBHOOK_SECRET` from key
     `TESSERIX_WEBHOOK_SECRET`, `revalidateUrl: https://tesserix.app/api/revalidate`.
   - `charts/thirdparty/istio-config/templates/network-policies.yaml`, policy `allow-cms-ingress`:
     add a `from` rule for `kubernetes.io/metadata.name: tesserix` on TCP 3000, next to the
     yes-hospital one.
4. **tesserix-k8s PR, site side.**
   - `charts/apps/company/values.yaml`: `env.CMS_URL: http://tesserix-cms.cms.svc.cluster.local`.
   - A new `external-secrets/prod/tesserix/cms-webhook.yaml` (copy of
     `external-secrets/prod/yes-hospital/cms-webhook.yaml`, namespace `tesserix`, target
     `company-cms`) and `envFrom` that secret in `charts/apps/company/templates/deployment.yaml`.
   - `charts/apps/company/templates/network-policy.yaml`, `allow-company-egress`: add a `to` rule for
     namespace `cms`, TCP 3000.
5. **Images.** Merge tesserix-cms `feat/tesserix-tenant`, build and pin its image in
   `argocd/prod/apps/global/tesserix-cms.yaml` (the PreSync migrate Job applies the new migration;
   the CI billing caveat in the handover doc still applies). Then merge this branch and pin the
   tesserix-home image on `company`.
6. **Seed.** Enable `jobs.seedTesserix` in `argocd/prod/apps/global/tesserix-cms.yaml` in one PR;
   after the Job completes, remove it in a follow-up. The Job is a no-op if the tenant already exists.
7. **Verify.** `curl -X POST https://tesserix.app/api/revalidate` → 401. In the admin, edit a
   product tagline, publish, reload tesserix.app within a minute, revert.
8. **People.** Create the first Tesserix Approver under Users (tenant Tesserix); the owner is already
   super-admin. The editor guide is `tesserix-cms/docs/cms-editor-guide.md`.
