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

## Cluster wiring (done 2026-11-19, tesserix-k8s #1714)

The wiring mirrors yes-hospital's: OpenBao policy/role `read-tesserix-cms-tesserix-production`, a
SecretStore in namespace `tesserix`, ExternalSecrets `tesserix-cms-tesserix-webhook` (ns `cms`) and
`company-cms` (ns `tesserix`), `jobs.seedTesserix` in the CMS chart, `CMS_URL` + `envFrom company-cms`
on the company chart, and the cms/tesserix network-policy rules. The OpenBao secret is
`tesserix-cms/app/tesserix-cms-tesserix-webhook-secret` (key `value`).

### Operating it

- **Image tags and one-off Jobs are live-owned, not git-owned.** `global-app-of-apps` ignores
  `/spec/source/helm/parameters` on its child Applications so Kargo's writes stick. A git change to
  `image.tag` or `jobs.<name>.enabled` in `argocd/prod/apps/global/tesserix-cms.yaml` is the audit
  trail; the mechanism is a patch on the child app:

  ```
  kubectl patch app tesserix-cms -n argocd --type merge \
    -p '{"spec":{"source":{"helm":{"parameters":[{"name":"image.tag","value":"main-<sha>"}]}}}}'
  ```

  Add `{"name":"jobs.seedTesserix.enabled","value":"true"}` to that array to run the seed, and
  patch the array back without it once the Job has completed. The seed is idempotent.
- **Never manually sync `global-app-of-apps`** (the refresh-annotate + operation patch in
  yes-hospital's handover doc). On 2026-11-19 it did not apply the tesserix-cms tag and did
  overwrite the Kargo-written tags on `company`, `console` and `platform-api` with stale git values;
  tesserix.app silently served an October build until the next Kargo promotion. If that happens
  again, re-promote the stage's current freight in `kargo-tesserix-home`.
- **The webhook is exempt from the CSRF gate** in `apps/web/middleware.ts` (it has no cookie and no
  Origin; the route checks `x-cms-secret`). Expect `401` from
  `curl -X POST https://tesserix.app/api/revalidate`, not `403`.
- **Is the site really reading the CMS?** The About page's team photos come from
  `storage.googleapis.com/tesserix-cms-media-prod-in/...`; the fallback uses `/team/<slug>.jpg`.
