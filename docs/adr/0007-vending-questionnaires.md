# ADR-0007: Vending research questionnaires

## Context and capacity

Two public, unauthenticated research forms feed an operator-only console. The
canonical host is `questionnaire.tesserix.app`, with `/vending-customers` and
`/vending-business`. Application code stays in this repository. Infrastructure
and SQL remain in tesserix-k8s, following the workspace schema ownership rule.

Planning assumptions, not measured traffic: 10,000 responses at 12 months and
100,000 at 36 months. At roughly 8 KiB per response that is 80 MiB and 800 MiB,
with a 2 GiB budget including indexes. Short bursts may reach 10 requests/second;
sustained public admission is capped at 120 new responses/minute. Reporting is
low-volume operator traffic. Target 99.9% monthly availability and p99 under one
second for ordinary submissions; these are targets, not demonstrated SLOs.

## Decision

Reuse apps/web for public rendering and submission, and apps/console for protected
reporting. The public host exposes only the exact form endpoints, research notice
and static assets. Reuse tesserix-postgres as explicitly requested; create the
`questionnaires` database with CNPG Database retain semantics. No new CNPG cluster,
service, queue, analytics datastore or independent identity project is needed.

Each form has an allowlisted stable ID, version 1, separate PostgreSQL schema and
response table. Customer product choices are also normalised in a child table.
Versioned supplementary answers are JSONB; frequently filtered location, currency,
price and product attributes have typed columns. These are research-form boundaries,
not customer login tenants. Respondents cannot read any responses. Existing console
identity and live platform capability checks decide operator access. A future
customer-facing dashboard would need a separate tenant-bound authorisation model.

A shared @tesserix/questionnaires package owns fields, options and Zod validation.
The public application gets only EXECUTE on a fixed SECURITY DEFINER submission
function, with a fixed search_path and no dynamic SQL; it has no response SELECT,
UPDATE or DELETE. The console uses a distinct read-only database role. Both secrets
are generated once with OpenBao CAS=0, scoped by namespace and exact path, and
projected through separate ESO readers. PostgreSQL TLS verifies the CNPG CA and
service hostname. No new GCP Secret Manager dependency is introduced.

A random submission key identifies one intent per form. The database compares
canonical JSON, returns the original receipt on replay, and rejects changed intent.
A transaction covers the response, products and persistent admission counters.
Client retries use the same key. There are no automatic network write retries.
A committed response whose HTTP reply is lost is recovered by replay.

Public submissions require an allowlisted browser Origin, JSON, a bounded streamed
16 KiB body, versioned strict validation, a blank honeypot and research consent.
Per-session browser and network information is HMACed with a daily boundary; raw
addresses are not stored in the research database. Six new responses/hour per
browser/network bucket limits casual repeat abuse without blocking everyone on
a gym's shared Wi-Fi. The global cap remains effective when address or browser
headers are spoofed. This is not proof of unique respondents or a CAPTCHA.
Marketing analytics are disabled on research paths.

## Reporting and research quality

Reports filter by venue type, country and campaign, use keyset pagination, keep
currencies separate, include zero prices and omit missing prices from medians.
All responses are the product-interest denominator, including no-interest responses.
A person may select up to five products and one selected first choice, or no products.
Votes across products need not sum to 100%. Site respondents and product respondents
are not implicitly joined by an unverified venue name.

An explicit exploratory heuristic requires 30 responses before any shortlist:
>=30% interest suggests a small pilot, 10–29% a limited test, and <10% lower priority.
These thresholds are not statistical confidence intervals or sales forecasts.
The operator must also consider price, purchasing frequency, competing options,
margin, expiry, cold chain, supplier minimums and observed pilot sales. No stock
orders, vendor commitments or outreach are automatically sent.

## Failure, delivery and rollback

Postgres is critical: an unavailable database produces a retryable 503; the client
retains intent and never claims a save. Reports show unavailability instead of zeros.
Zitadel/session verification failure refuses console access; public forms need no
identity service. OpenBao/ESO failure blocks new credential provisioning, while
already-running workloads retain their mounted configuration. No application secret
is exposed to the browser. Optional marketing analytics are outside the survey path.

SQL is additive and idempotent, applied by a dedicated GitOps bootstrap target only
to questionnaires. Roll back the two application images and disable questionnaire
routing/configuration via a GitOps revert; retain the database, roles, response tables
and OpenBao versions. There is intentionally no destructive production down migration.
To recreate from scratch, restore the existing CNPG backup using the platform runbook,
reconcile roles/secrets and replay the schema. This task tests schema replay on a
scratch PostgreSQL database; it does not claim a fresh full-cluster disaster restore.

No additional always-on workload or PVC is introduced. Incremental cost is response
storage/WAL and modest CPU within the existing applications. Existing tesserix-postgres
backup and continuous archiving apply; confirm their health during rollout. Operational
signals are submission 5xx/429 rates, latency and schema bootstrap failures. Use existing
application/ingress monitoring initially; no dedicated paging alert is justified for a
low-volume pre-launch research form until traffic and ownership are established.

Business contact information is restricted to console operators. The published
collection notice explains research/follow-up use, optional data and privacy requests.
Review identifiable contacts when the feasibility exercise ends; retention is not
"forever" and backup retention must be considered for an erasure. Never collect
medical details, access credentials, alarm codes or payment-card data.

## Research reviewed, 17 October 2026

- [Pew Research Center: Writing Survey Questions](https://www.pewresearch.org/writing-survey-questions/): neutral wording, one concept per question and meaningful response choices.
- [FSANZ: Food safety for food businesses](https://www.foodstandards.gov.au/business/food-safety): food-business obligations require an operational assessment beyond a survey.
- [FSANZ: 2-hour / 4-hour rule](https://www.foodstandards.gov.au/business/food-safety/2-hour-4-hour-rule): temperature exposure accumulates across storage, transport and display; chilled/fresh products need a verified cold-chain design.
- [OAIC: APP 5 collection notification](https://www.oaic.gov.au/privacy/australian-privacy-principles-guidelines/chapter-5-app-5-notification-of-the-collection-of-personal-information): explain collection and use at the point of collection.

Australian references inform this initial questionnaire, not legal approval in every
location. Currency and country fields support international research; local food,
electrical, accessibility, tenancy and privacy requirements must be checked before
an installation. A survey cannot establish regulatory compliance or site readiness.
