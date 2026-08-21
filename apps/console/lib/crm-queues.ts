// `server-only`: this module reaches Postgres on one branch and an operator's
// bearer token on the other. A client component importing it must fail the
// build, not ship `pg` to the browser — see #299.
import "server-only";

import { randomUUID } from "node:crypto";
import type { QueueFilter, QueuePage, SetNextActionInput } from "@/lib/db/crm-repo";
import {
  driftingOpportunities,
  dueOpportunities,
  MissingProductError,
  setNextAction,
} from "@/lib/db/crm-repo";
import { MalformedCursorError } from "@/lib/db/keyset-cursor";
import { PlatformApiError } from "@/lib/platform-api-error";
import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";
import { parseQueuePage } from "@/lib/crm-queue-wire";
import { queueQuery } from "@/lib/crm-queue-query";

/**
 * Where the CRM queues get their data.
 *
 * Two backends behind one set of signatures, chosen by `PLATFORM_API_ORIGIN` —
 * the same switch `fetchTickets` uses, and for the same reason: UNSET IS
 * BYTE-FOR-BYTE THE OLD BEHAVIOUR, so this whole phase reverts by removing one
 * variable rather than by reverting code.
 *
 * `crm-repo.ts` is deliberately not modified. It is a database module; teaching
 * it to speak HTTP would put a transport inside the layer whose entire job is
 * SQL, and it is 2,499 lines already. The seam belongs here, one level up,
 * where the pages import from.
 *
 * # A note on cursors, because this is a real behaviour change
 *
 * The two backends mint cursors with DIFFERENT CODECS. `keyset-cursor.ts`
 * encodes `(timestamp, uuid, direction)`; the platform API encodes
 * `{v, d, k}` as base64url and includes the queue's own name so one queue's
 * cursor cannot page the other. Within either backend the cursors are
 * self-consistent, and the console always echoes back whatever it was handed.
 *
 * The seam is a link BOOKMARKED before the cutover and opened after it: the
 * platform API cannot decode a console-minted cursor and answers 400 "the
 * cursor could not be read; start from the first page". That refusal is
 * honest and actionable — but only once it reaches the page as a
 * `MalformedCursorError`, which is what `fetchDueQueue` and
 * `fetchDriftingQueue` translate it into below. Left as a bare
 * `PlatformApiError` it matches none of `dbReadError`'s classifications and
 * renders as the generic "Try again shortly." — the exact fate
 * `invalidCursorMessage` exists to prevent. So the cursor-codec break is
 * accepted, but not by teaching either side the other's codec: by
 * re-classifying the refusal at this seam, where both codecs are already in
 * view.
 *
 * # WHICH SIDE OF THE SEAM A REFUSAL GETS FIXED ON
 *
 * Both answers are in use, and the rule that separates them is:
 *
 * RE-CLASSIFY AT THIS SEAM when the other backend's refusal has an existing
 * console-vocabulary equivalent — a 400 cursor refusal IS a
 * `MalformedCursorError`, a 422 terminal-stage refusal IS an empty page.
 * EXTEND THE CENTRAL CLASSIFIER when the condition is new and has nothing to
 * translate into: "no usable token row" has no Postgres analogue, so inventing
 * a fake SQLSTATE to carry it would be worse. That one is a marker
 * (`noOperatorToken`) that `dbReadError` and `toSurfaceError` both read
 * structurally, which is why the sentence this comment used to carry — that
 * `dbReadError` knows only Postgres-shaped markers — is no longer true.
 *
 * The cursor refusal above is one such case; two more sit on this seam for
 * the same root cause — the console's error vocabulary (`MalformedCursorError`, `MissingProductError`)
 * is Postgres-shaped, and these platform API refusals arrive as a bare
 * `PlatformApiError` that matches none of it:
 *
 * - a terminal-stage filter (`?stage=won`/`lost`) is a 422 from the Go side,
 *   by design; the Postgres path's `WHERE` clause simply excludes those
 *   stages, so it "fails" by matching nothing. `fetchDueQueue` and
 *   `fetchDriftingQueue` match that 422 and return an empty `QueuePage`
 *   rather than throwing, for parity with what the Postgres path already
 *   does. (Both paths arguably violate `readQueueFilters`' documented "a bad
 *   value should read as unfiltered, not break the page" contract — stage is
 *   not narrowed to open values there, so a terminal stage reaches here at
 *   all. Fixing that is a separate change, on both sides at once, not a
 *   parity break introduced here.)
 * - a grandfathered opportunity with no product is a 422 from the Go side;
 *   `saveNextAction` matches it and rethrows `MissingProductError`, which
 *   `mapMissingProduct` already knows how to render.
 */

/** An empty page, byte-for-byte what the Postgres path returns when a
 *  `WHERE` clause matches nothing — the shape a terminal-stage filter (won,
 *  lost) produces there, and the shape the platform API's 422 refusal of the
 *  same filter is translated into below. */
const EMPTY_QUEUE_PAGE: QueuePage = {
  rows: [],
  total: 0,
  precedingCount: 0,
  nextCursor: null,
  previousCursor: null,
};

/** True for the platform API's refusal of a cursor it cannot decode — the
 *  BAD_REQUEST 400 from `handler.go`. Matched on message text, not `code`,
 *  because the Go side gives BAD_REQUEST for more than one failure and the
 *  code alone can't tell this refusal apart from the others; that string is
 *  pinned by the handler's own golden file
 *  (`testdata/error-bad-cursor.json`), so a wording change there breaks this
 *  test loudly rather than silently falling back to the generic message. */
function isCursorRefusal(error: PlatformApiError): boolean {
  return error.status === 400 && error.message.includes("the cursor could not be read");
}

/** True for the platform API's refusal of a terminal-stage filter
 *  (`?stage=won`/`lost`) — a 422 `VALIDATION_FAILED`, by design
 *  (`handler.go`). Matched on message text so a different 422 — a bad limit,
 *  a conflicting filter axis — is not swallowed along with it; pinned by
 *  `testdata/error-terminal-stage.json`. */
function isTerminalStageRefusal(error: PlatformApiError): boolean {
  return error.status === 422 && error.message.includes("is terminal");
}

/** True for the platform API's refusal to update a grandfathered opportunity
 *  that has no product — a 422 `VALIDATION_FAILED` from
 *  `repository/next_action.go`'s `ErrProductRequired`. Matched on message
 *  text for the same reason as the other two; pinned by
 *  `testdata/next-action-product-required.json`. */
function isProductRequiredRefusal(error: PlatformApiError): boolean {
  return (
    error.status === 422 && error.message.includes("migrated without a product")
  );
}

async function fetchQueuePage(
  label: string,
  path: string,
  cursorLabel: string,
): Promise<QueuePage> {
  try {
    const { data, meta } = await platformRequestWithMeta(label, path);
    return parseQueuePage(data, meta);
  } catch (error) {
    if (error instanceof PlatformApiError && isCursorRefusal(error)) {
      throw new MalformedCursorError(cursorLabel);
    }
    if (error instanceof PlatformApiError && isTerminalStageRefusal(error)) {
      return EMPTY_QUEUE_PAGE;
    }
    throw error;
  }
}

export async function fetchDueQueue(
  filter: QueueFilter,
  limit: number,
  cursor?: string,
): Promise<QueuePage> {
  if (!platformApiOrigin()) {
    return dueOpportunities(filter, limit, cursor);
  }
  const query = queueQuery(filter, limit, cursor);
  return fetchQueuePage("crm due queue", `/v1/crm/queues/due?${query.toString()}`, "dueOpportunities");
}

export async function fetchDriftingQueue(
  filter: QueueFilter,
  staleDays: number,
  limit: number,
  cursor?: string,
): Promise<QueuePage> {
  if (!platformApiOrigin()) {
    return driftingOpportunities(filter, staleDays, limit, cursor);
  }
  const query = queueQuery(filter, limit, cursor);
  // Set after the shared parameters so the ordering is stable and the tests can
  // assert on a whole URL rather than parsing it back apart.
  query.set("stale_days", String(staleDays));
  return fetchQueuePage(
    "crm drifting queue",
    `/v1/crm/queues/drifting?${query.toString()}`,
    "driftingOpportunities",
  );
}

export async function saveNextAction(input: SetNextActionInput): Promise<void> {
  if (!platformApiOrigin()) {
    return setNextAction(input);
  }
  // `actor` is not sent: the platform API takes the actor from the bearer
  // token's principal and records it in its own audit row. Sending a
  // caller-supplied actor would let the client name someone else.
  try {
    await platformRequestWithMeta(
      "crm next action",
      `/v1/crm/opportunities/${encodeURIComponent(input.opportunityId)}/next-action`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          // Scheduling the same next action twice is harmless, but the write is
          // still a write: a retry after a timeout must not produce a second
          // audit row. The key is per attempt, minted here.
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ at: input.at, note: input.note }),
      },
    );
  } catch (error) {
    if (error instanceof PlatformApiError && isProductRequiredRefusal(error)) {
      throw new MissingProductError(input.opportunityId);
    }
    throw error;
  }
}
