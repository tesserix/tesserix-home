// B1 — Email templates registry (cross-DB write to mark8ly).
//
// Tesserix-home is the authoring surface; templates live in each
// product service's own DB so the product owns its data and the
// runtime send path has no dependency on tesserix-home. We use the
// existing cross-DB grant on mark8ly_platform_admin to UPSERT rows
// into mark8ly_platform_api.email_templates. After every write we
// ping mark8ly's /internal/templates/refresh so the in-process cache
// is evicted and the change is live within a request round-trip
// rather than waiting for the 5-minute TTL.
//
// Schema (mark8ly platform-api migration 0013):
//
//   email_templates(
//     key text PK,
//     subject text, html_body text, text_body text,
//     variables jsonb, status text default 'published',
//     version int default 1,
//     updated_at timestamptz, updated_by text)
//
// Status semantics:
//   - 'published' → live; loader uses this row
//   - 'draft' → not live; loader treats as missing → embedded fallback

import type { Mark8lyDatabase } from "./mark8ly";
import { mark8lyQuery } from "./mark8ly";

export type TemplateStatus = "published" | "draft";

export interface TemplateVariable {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface EmailTemplate {
  readonly database: Mark8lyDatabase;
  readonly key: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables: ReadonlyArray<TemplateVariable>;
  readonly status: TemplateStatus;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export interface EmailTemplateUpsert {
  readonly key: string;
  readonly subject: string;
  readonly htmlBody: string;
  readonly textBody: string;
  readonly variables?: ReadonlyArray<TemplateVariable>;
  readonly status?: TemplateStatus;
  readonly updatedBy: string;
}

interface RawRow {
  key: string;
  subject: string;
  html_body: string;
  text_body: string;
  variables: unknown;
  status: string;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

function rowToTemplate(database: Mark8lyDatabase, r: RawRow): EmailTemplate {
  return {
    database,
    key: r.key,
    subject: r.subject,
    htmlBody: r.html_body,
    textBody: r.text_body,
    variables: parseVariables(r.variables),
    status: (r.status === "draft" ? "draft" : "published") as TemplateStatus,
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

export async function listEmailTemplates(
  database: Mark8lyDatabase = "platform_api",
): Promise<EmailTemplate[]> {
  const sql = `
    SELECT key, subject, html_body, text_body, variables, status, version, updated_at, updated_by
    FROM email_templates
    ORDER BY key ASC
  `;
  const res = await mark8lyQuery<RawRow>(database, sql);
  return res.rows.map((r) => rowToTemplate(database, r));
}

export async function getEmailTemplate(
  database: Mark8lyDatabase,
  key: string,
): Promise<EmailTemplate | null> {
  const sql = `
    SELECT key, subject, html_body, text_body, variables, status, version, updated_at, updated_by
    FROM email_templates
    WHERE key = $1
  `;
  const res = await mark8lyQuery<RawRow>(database, sql, [key]);
  if (res.rows.length === 0) return null;
  return rowToTemplate(database, res.rows[0]);
}

export async function upsertEmailTemplate(
  database: Mark8lyDatabase,
  upd: EmailTemplateUpsert,
): Promise<EmailTemplate> {
  const status: TemplateStatus = upd.status ?? "published";
  const variables = upd.variables ?? [];
  const sql = `
    INSERT INTO email_templates
      (key, subject, html_body, text_body, variables, status, version, updated_at, updated_by)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1, now(), $7)
    ON CONFLICT (key) DO UPDATE SET
      subject    = EXCLUDED.subject,
      html_body  = EXCLUDED.html_body,
      text_body  = EXCLUDED.text_body,
      variables  = EXCLUDED.variables,
      status     = EXCLUDED.status,
      version    = email_templates.version + 1,
      updated_at = now(),
      updated_by = EXCLUDED.updated_by
    RETURNING key, subject, html_body, text_body, variables, status, version, updated_at, updated_by
  `;
  const params: unknown[] = [
    upd.key,
    upd.subject,
    upd.htmlBody,
    upd.textBody,
    JSON.stringify(variables),
    status,
    upd.updatedBy,
  ];
  const res = await mark8lyQuery<RawRow>(database, sql, params);
  return rowToTemplate(database, res.rows[0]);
}
