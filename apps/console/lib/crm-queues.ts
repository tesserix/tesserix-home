// `server-only`: this module reaches Postgres on one branch and an operator's
// bearer token on the other. A client component importing it must fail the
// build, not ship `pg` to the browser — see #299.
import "server-only";

import { randomUUID } from "node:crypto";
import type { QueueFilter, QueuePage, SetNextActionInput } from "@/lib/db/crm-repo";
import {
  driftingOpportunities,
  dueOpportunities,
  setNextAction,
} from "@/lib/db/crm-repo";
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
 * cursor could not be read; start from the first page". That is an honest,
 * actionable refusal rather than wrong rows, which is why it is accepted rather
 * than papered over by teaching either side the other's codec.
 */

export async function fetchDueQueue(
  filter: QueueFilter,
  limit: number,
  cursor?: string,
): Promise<QueuePage> {
  if (!platformApiOrigin()) {
    return dueOpportunities(filter, limit, cursor);
  }
  const query = queueQuery(filter, limit, cursor);
  const { data, meta } = await platformRequestWithMeta(
    "crm due queue",
    `/v1/crm/queues/due?${query.toString()}`,
  );
  return parseQueuePage(data, meta);
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
  const { data, meta } = await platformRequestWithMeta(
    "crm drifting queue",
    `/v1/crm/queues/drifting?${query.toString()}`,
  );
  return parseQueuePage(data, meta);
}

export async function saveNextAction(input: SetNextActionInput): Promise<void> {
  if (!platformApiOrigin()) {
    return setNextAction(input);
  }
  // `actor` is not sent: the platform API takes the actor from the bearer
  // token's principal and records it in its own audit row. Sending a
  // caller-supplied actor would let the client name someone else.
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
}
