---
slug: tickets-reject-unknown-parameters
date: 2026-08-20
issue: 302
---

# Tickets: refuse unknown query parameters (via a kernel extraction)

## Why now

Time-limited. Tickets can only be made strict while it has no external
consumers; once a product pins to it, adding this check is a breaking change.
The console's migration is still gated (conventions §10 step 5), so the window
is open — and it closes at the cutover.

## Shape: extract, do not copy

`rejectUnknownParameters` lives in the CRM handler. Tickets now wants it, and
§8 says a helper two modules both want belongs in the kernel; §9 says the shape
moves on the second example. This is that second example, so it moves rather
than being duplicated.

`internal/platform/httpx` is the sanctioned kernel — `internal/architecture`'s
`TestModuleMayImportThePlatformKernel` names it explicitly.

## Verified before planning

- `/v1/tickets/summary` is called by the console with NO query string
  (`platformRequest("tickets summary", "/v1/tickets/summary")`), so an empty
  allowed set is safe.
- `/v1/tickets` receives `status`, `priority`, `product` (from `ticketsQuery`)
  plus `limit`. The handler also reads `tenant` and `cursor`.
- Baseline `go test ./...` is green with ZERO skips against a real Postgres.

## Allowed sets

| route | allowed |
|---|---|
| `GET /v1/tickets` | status, priority, product, tenant, limit, cursor |
| `GET /v1/tickets/summary` | (none) |

`tenant` and `cursor` are included because `list` reads them, even though the
console does not send them today. The set is what the ROUTE reads, not what one
caller happens to send.

## Tasks

1. Move `rejectUnknownParameters` into `internal/platform/httpx` as an exported
   `RejectUnknownParameters`. Keep the sorted-accepted-set behaviour and the
   `details` shape (each unknown parameter keyed to the value it carried, plus
   `accepted`). Generalise the doc comment away from CRM specifics while
   keeping the reasoning. Tests first.
2. Point CRM at the kernel; delete the local copy. CRM's behaviour and golden
   files must not change — that is the regression bar for the extraction.
3. Apply it to tickets `list` and `summary`. Tests first.
4. Regenerate tickets goldens; the diff is the visible record of the contract
   change.

## Bar

`go test ./...` green with zero skips, and CRM goldens byte-identical.
