// B2 — Lead invite + marketing templates (tesserix_admin DB).
//
// These are *platform-owned* templates used when tesserix-home sends
// directly to a lead (or a marketing audience), bypassing any product
// service. Distinct from product transactional templates which live
// in the product's own DB and ship via the product's send pipeline.
//
// Schema lives in migration 0005 alongside email_events.

import { tesserixQuery } from "./tesserix";

export type LeadTemplateStatus = "published" | "draft";

export interface TemplateVariable {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface LeadTemplate {
  readonly key: string;
  readonly label: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: ReadonlyArray<TemplateVariable>;
  readonly status: LeadTemplateStatus;
  readonly product: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export interface LeadTemplateUpsert {
  readonly key: string;
  readonly label: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables?: ReadonlyArray<TemplateVariable>;
  readonly status?: LeadTemplateStatus;
  readonly product?: string;
  readonly updatedBy: string;
}

interface RawRow {
  key: string;
  label: string;
  subject: string;
  html_body: string;
  text_body: string;
  variables: unknown;
  status: string;
  product: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

function rowToTemplate(r: RawRow): LeadTemplate {
  return {
    key: r.key,
    label: r.label,
    subject: r.subject,
    htmlBody: r.html_body,
    textBody: r.text_body,
    variables: parseVariables(r.variables),
    status: (r.status === "draft" ? "draft" : "published") as LeadTemplateStatus,
    product: r.product,
    version: r.version,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

function parseVariables(raw: unknown): TemplateVariable[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => {
      if (typeof v !== "object" || v === null) return null;
      const obj = v as Record<string, unknown>;
      const name = typeof obj.name === "string" ? obj.name : "";
      if (!name) return null;
      return {
        name,
        type: typeof obj.type === "string" ? obj.type : "string",
        required: typeof obj.required === "boolean" ? obj.required : false,
      } satisfies TemplateVariable;
    })
    .filter((v): v is TemplateVariable => v !== null);
}

export async function listLeadTemplates(): Promise<LeadTemplate[]> {
  const sql = `
    SELECT key, label, subject, html_body, text_body, variables, status,
           product, version, updated_at, updated_by
    FROM platform_lead_templates
    ORDER BY product, key
  `;
  const res = await tesserixQuery<RawRow>(sql);
  return res.rows.map(rowToTemplate);
}

export async function getLeadTemplate(key: string): Promise<LeadTemplate | null> {
  const sql = `
    SELECT key, label, subject, html_body, text_body, variables, status,
           product, version, updated_at, updated_by
    FROM platform_lead_templates
    WHERE key = $1
  `;
  const res = await tesserixQuery<RawRow>(sql, [key]);
  if (res.rows.length === 0) return null;
  return rowToTemplate(res.rows[0]);
}

export async function upsertLeadTemplate(
  upd: LeadTemplateUpsert,
): Promise<LeadTemplate> {
  const sql = `
    INSERT INTO platform_lead_templates
      (key, label, subject, html_body, text_body, variables, status, product, version, updated_at, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 1, now(), $9)
    ON CONFLICT (key) DO UPDATE SET
      label      = EXCLUDED.label,
      subject    = EXCLUDED.subject,
      html_body  = EXCLUDED.html_body,
      text_body  = EXCLUDED.text_body,
      variables  = EXCLUDED.variables,
      status     = EXCLUDED.status,
      product    = EXCLUDED.product,
      version    = platform_lead_templates.version + 1,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    RETURNING key, label, subject, html_body, text_body, variables, status,
              product, version, updated_at, updated_by
  `;
  const res = await tesserixQuery<RawRow>(sql, [
    upd.key,
    upd.label,
    upd.subject,
    upd.htmlBody,
    upd.textBody,
    JSON.stringify(upd.variables ?? []),
    upd.status ?? "published",
    upd.product ?? "",
    upd.updatedBy,
  ]);
  return rowToTemplate(res.rows[0]);
}

// ─── Outbound send log ───────────────────────────────────────────────

export interface OutboundEmailLog {
  readonly idempotencyKey: string;
  readonly templateKey: string;
  readonly templateVersion: number | null;
  readonly product: string;
  readonly leadId: string | null;
  readonly recipient: string;
  readonly subject: string;
  readonly sentAt: Date | null;
  readonly sgMessageId: string | null;
  readonly errorMessage: string | null;
  readonly sentBy: string;
}

// recordOutboundEmail inserts a log row before the SendGrid call so we
// have a record even if the process crashes mid-flight. Idempotent:
// a duplicate idempotency_key returns the existing row.
export async function recordOutboundEmail(log: OutboundEmailLog): Promise<number | null> {
  const sql = `
    INSERT INTO platform_outbound_emails
      (idempotency_key, template_key, template_version, product, lead_id,
       recipient, subject, sent_at, sg_message_id, error_message, sent_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  const res = await tesserixQuery<{ id: number }>(sql, [
    log.idempotencyKey,
    log.templateKey,
    log.templateVersion,
    log.product,
    log.leadId,
    log.recipient,
    log.subject,
    log.sentAt?.toISOString() ?? null,
    log.sgMessageId,
    log.errorMessage,
    log.sentBy,
  ]);
  return res.rows[0]?.id ?? null;
}

export async function updateOutboundEmail(
  idempotencyKey: string,
  patch: { sgMessageId?: string; sentAt?: Date; errorMessage?: string | null },
): Promise<void> {
  await tesserixQuery(
    `UPDATE platform_outbound_emails
     SET sg_message_id = COALESCE($2, sg_message_id),
         sent_at       = COALESCE($3, sent_at),
         error_message = $4
     WHERE idempotency_key = $1`,
    [
      idempotencyKey,
      patch.sgMessageId ?? null,
      patch.sentAt?.toISOString() ?? null,
      patch.errorMessage ?? null,
    ],
  );
}
