# Vending questionnaires

Public links:

- https://questionnaire.tesserix.app/vending-customers
- https://questionnaire.tesserix.app/vending-business

Console: https://console.tesserix.app/platform/questionnaires

## Circulate the forms

Send the customer link to prospective users and the business link to a venue's
authorised contact. A campaign code can distinguish a venue or distribution round:
`https://questionnaire.tesserix.app/vending-customers?campaign=melbourne-gym-pilot`.
The form pre-fills that code. Use the same non-personal code on the business survey
if useful. Codes are research labels, not authentication or verified venue identity.
Do not place emails, private addresses or credentials in URL parameters.

Customers need no account or contact information. Businesses interested in a pilot provide contact details
and explicitly acknowledge research and site follow-up. Neither form signs people up
for marketing, orders stock, commits a lease, or approves an installation. Review
questions with a small pilot audience before broad distribution. Do not circulate
real security/access credentials or ask respondents for sensitive medical information.

## Country, address and currency

1. Choose the venue country. The existing Mark8ly public country catalog supplies the
   country name and local currency; currently it covers 20 countries and 16 currencies.
2. Optionally search for a public venue or street. Select a suggestion with a click,
   or use the arrow keys and Enter. Street, city, region and postcode populate together.
3. Check the result and correct any field manually. A missing result is not an address
   validation failure. No GPS permission, account, login or one-time password is needed.
4. Currency automatically follows the chosen country. Change it explicitly if an
   estimate is quoted in another currency. We never convert an already-entered amount;
   recheck price answers after changing country or currency.

Search is debounced by 400ms, stale requests are cancelled, results are scoped to the
selected country, and upstream requests have a 4.5s deadline. Changing country clears
previous address fields. The fixed server-side proxy calls the existing Mark8ly storefront
address endpoint and never forwards cookies or bearer credentials. Its Photon provider
can return an empty list on upstream failure, so empty results always offer manual entry.
The catalog is cached for a day and has a snapshot fallback; address search failure
never prevents manually completing the form. Address searches are optional, transient
requests; only a submitted address is part of the retained response. Read the collection
notice before entering any address. Do not use home addresses or private access details.

The anonymous lookup POST is `/api/questionnaires/location`, with a bounded body and
an explicit origin check. Shared PostgreSQL admission permits at most 300 searches/minute
globally and 30/minute per hashed browser/network/day bucket across all app replicas.
The proxy fails closed to manual entry if admission is unavailable. Browser IDs do not
verify unique people; the global limit remains effective if a caller rotates identifiers.
JPY uses whole-unit amounts and the other supported currencies use two decimal places.
Reports interpret stored minor units by currency and never mix or convert currencies.

For local integration only, `QUESTIONNAIRES_LOCATION_LOCAL=true` in Next development
uses localhost ports 18206 (existing platform-api) and 18207 (existing storefront),
which can be supplied by read-only port forwards. Production ignores this setting.

## Review responses

1. Sign into the console with an authorised operator account and platform capability.
2. Open Questionnaires in the platform navigation.
3. Select customer or business responses. Filter by venue type, country and campaign.
4. Inspect response details; follow up on unknown business assumptions before a proposal.
5. Compare interest and first-choice votes. Low sample sizes say "Collect more responses".
6. Compare stated maximum prices within each currency. Blank and zero are different.
7. Run a small stock pilot, record actual sell-through and waste separately, then revise
   the range. The initial survey does not contain costs, margins or observed sales, so
   it cannot calculate a defensible order quantity or determine profitability.

The read-only JSON report uses `/api/questionnaires?form=vending-customers` on the
console, the same session/operator/capability boundary and a maximum 30-response page.
Pass its `nextCursor` as `after` for older responses. `venue`, `country` and `campaign`
are optional bounded filters. No machine or public read API is exposed.

## Develop and add future forms

Application code: `packages/questionnaires`, `apps/web/components/questionnaires`,
public page/API routes in apps/web, and `apps/console/app/(console)/platform/questionnaires`.
SQL source: `tesserix-k8s/charts/apps/db-schema-bootstrap/schemas/questionnaires/tesserix`.

Add a stable, specific form slug and a dedicated schema/response table. Add shared
validation/fields, a public page and exact ingress/API allowlists. Extend the fixed
submission function deliberately; never accept an arbitrary table name or tenant from
an anonymous caller. Extend console reporting and tests. Preserve old versions and
receipts; add columns/version adapters before changing the meaning of existing answers.
Do not silently reinterpret old responses under new wording.

Set the writer role in the public application's environment and the reader role in
console. Both require QUESTIONNAIRES_DB_PASSWORD and QUESTIONNAIRES_DB_CA from their
scoped secret projections. The fixed database is questionnaires. Pools use two
connections/process; production verifies TLS. QUESTIONNAIRES_DB_LOCAL=true is only for
scratch local PostgreSQL. It must never be enabled in production.

OpenBao paths:
`kv/data/questionnaires/prod/app/questionnaires-writer-password` and
`kv/data/questionnaires/prod/app/questionnaires-reader-password`.
The GitOps seed uses CAS=0 and preserves existing values. Rotation must coordinate
OpenBao, ESO, CNPG role reconciliation and application rollout; never change one
consumer alone. No credentials belong in Git, screenshots or public test output.

See [ADR-0007](../adr/0007-vending-questionnaires.md) for evidence, capacity, security,
known survey limitations and rollback. See tesserix-k8s `docs/questionnaires.md` for
provisioning and scratch database verification.
