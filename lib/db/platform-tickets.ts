// Platform tickets data access. Lives in tesserix-postgres (tesserix_admin
// schema). Reads/writes via the tesserix pool (NOT mark8ly's pool).

import { tesserixQuery, tesserixTx } from "./tesserix";

export interface PlatformTicketRow {
  readonly id: string;
  readonly product_id: string;
  readonly tenant_id: string;
  readonly ticket_number: string;
  readonly subject: string;
  readonly description: string;
  readonly status: string;
  readonly priority: string;
  readonly submitted_by_name: string;
  readonly submitted_by_email: string;
  readonly submitted_by_user_id: string | null;
  readonly resolved_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PlatformTicketReplyRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly author_type: "merchant" | "platform_admin";
  readonly author_name: string;
  readonly author_email: string | null;
  readonly author_user_id: string | null;
  readonly content: string;
  readonly created_at: string;
}

export interface ListFilter {
  readonly status?: string;
  readonly priority?: string;
  readonly productId?: string;
  readonly tenantId?: string;
  readonly limit?: number;
}

const PRODUCT_PREFIX: Readonly<Record<string, string>> = {
  mark8ly: "M8",
  homechef: "HC",
  fanzone: "FZ",
};

export async function listPlatformTickets(filter: ListFilter = {}): Promise<PlatformTicketRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (filter.status) {
    where.push(`status = $${i++}`);
    params.push(filter.status);
  }
  if (filter.priority) {
    where.push(`priority = $${i++}`);
    params.push(filter.priority);
  }
  if (filter.productId) {
    where.push(`product_id = $${i++}`);
    params.push(filter.productId);
  }
  if (filter.tenantId) {
    where.push(`tenant_id = $${i++}::uuid`);
    params.push(filter.tenantId);
  }
  const limit = Math.min(filter.limit ?? 200, 1000);
  const sql = `
    SELECT id, product_id, tenant_id::text, ticket_number, subject, description,
           status, priority, submitted_by_name, submitted_by_email,
           submitted_by_user_id::text, resolved_at, created_at, updated_at
    FROM tesserix_admin.platform_tickets
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY
      CASE WHEN status IN ('open','in_progress') THEN 0 ELSE 1 END,
      CASE priority
        WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
        WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4
      END,
      updated_at DESC
    LIMIT ${limit}
  `;
  const res = await tesserixQuery<PlatformTicketRow>(sql, params);
  return res.rows;
}

export async function getPlatformTicket(id: string): Promise<PlatformTicketRow | null> {
  const res = await tesserixQuery<PlatformTicketRow>(
    `SELECT id, product_id, tenant_id::text, ticket_number, subject, description,
            status, priority, submitted_by_name, submitted_by_email,
            submitted_by_user_id::text, resolved_at, created_at, updated_at
     FROM tesserix_admin.platform_tickets WHERE id = $1::uuid`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function getPlatformTicketReplies(ticketId: string): Promise<PlatformTicketReplyRow[]> {
  const res = await tesserixQuery<PlatformTicketReplyRow>(
    `SELECT id, ticket_id::text, author_type, author_name, author_email,
            author_user_id::text, content, created_at
     FROM tesserix_admin.platform_ticket_replies
     WHERE ticket_id = $1::uuid
     ORDER BY created_at ASC`,
    [ticketId],
  );
  return res.rows;
}

export interface CreateTicketInput {
  productId: string;
  tenantId: string;
  subject: string;
  description: string;
  priority?: string;
  submittedByName: string;
  submittedByEmail: string;
  submittedByUserId?: string;
}

export async function createPlatformTicket(input: CreateTicketInput): Promise<PlatformTicketRow> {
  return tesserixTx(async (client) => {
    const seqRes = await client.query<{ n: string }>(
      `SELECT nextval('tesserix_admin.platform_tickets_seq')::text AS n`,
    );
    const n = Number(seqRes.rows[0]?.n ?? "1");
    const prefix = PRODUCT_PREFIX[input.productId] ?? input.productId.slice(0, 2).toUpperCase();
    const ticketNumber = `${prefix}-${String(n).padStart(4, "0")}`;

    const insRes = await client.query<PlatformTicketRow>(
      `INSERT INTO tesserix_admin.platform_tickets
         (product_id, tenant_id, ticket_number, subject, description,
          priority, submitted_by_name, submitted_by_email, submitted_by_user_id)
       VALUES ($1, $2::uuid, $3, $4, $5, COALESCE($6, 'medium'), $7, $8, $9::uuid)
       RETURNING id, product_id, tenant_id::text, ticket_number, subject, description,
                 status, priority, submitted_by_name, submitted_by_email,
                 submitted_by_user_id::text, resolved_at, created_at, updated_at`,
      [
        input.productId,
        input.tenantId,
        ticketNumber,
        input.subject,
        input.description,
        input.priority ?? null,
        input.submittedByName,
        input.submittedByEmail,
        input.submittedByUserId ?? null,
      ],
    );
    return insRes.rows[0];
  });
}

export interface CreateReplyInput {
  ticketId: string;
  authorType: "merchant" | "platform_admin";
  authorName: string;
  authorEmail?: string;
  authorUserId?: string;
  content: string;
  newStatus?: string;
}

export async function createPlatformTicketReply(input: CreateReplyInput): Promise<PlatformTicketReplyRow> {
  return tesserixTx(async (client) => {
    const replyRes = await client.query<PlatformTicketReplyRow>(
      `INSERT INTO tesserix_admin.platform_ticket_replies
         (ticket_id, author_type, author_name, author_email, author_user_id, content)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6)
       RETURNING id, ticket_id::text, author_type, author_name, author_email,
                 author_user_id::text, content, created_at`,
      [
        input.ticketId,
        input.authorType,
        input.authorName,
        input.authorEmail ?? null,
        input.authorUserId ?? null,
        input.content,
      ],
    );
    if (input.newStatus) {
      await client.query(
        `UPDATE tesserix_admin.platform_tickets
           SET status = $1,
               resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE resolved_at END
         WHERE id = $2::uuid`,
        [input.newStatus, input.ticketId],
      );
    }
    return replyRes.rows[0];
  });
}

export interface PlatformTicketsSummary {
  readonly open: number;
  readonly inProgress: number;
  readonly resolvedThisWeek: number;
  readonly urgentOpen: number;
}

export async function getPlatformTicketsSummary(): Promise<PlatformTicketsSummary> {
  const res = await tesserixQuery<{
    open: string;
    in_progress: string;
    resolved_this_week: string;
    urgent_open: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'open')::bigint AS open,
       count(*) FILTER (WHERE status = 'in_progress')::bigint AS in_progress,
       count(*) FILTER (WHERE status = 'resolved' AND resolved_at >= now() - interval '7 days')::bigint AS resolved_this_week,
       count(*) FILTER (WHERE status IN ('open','in_progress') AND priority = 'urgent')::bigint AS urgent_open
     FROM tesserix_admin.platform_tickets`,
  );
  const r = res.rows[0];
  return {
    open: Number(r?.open ?? 0),
    inProgress: Number(r?.in_progress ?? 0),
    resolvedThisWeek: Number(r?.resolved_this_week ?? 0),
    urgentOpen: Number(r?.urgent_open ?? 0),
  };
}
