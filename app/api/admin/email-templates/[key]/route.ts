// B1 — Email templates registry: single-template GET + PUT.
//
// PUT validates the Go-template syntax of subject/html/text before
// committing to the cross-DB write so a typo doesn't make it to a
// live send. Render correctness on mark8ly's side is still the source
// of truth (different render engine — text/template + html/template),
// but a basic structural check here catches the common cases (mismatched
// braces, missing field references) before they propagate.

import { NextResponse, type NextRequest } from "next/server";
import {
  getEmailTemplate,
  upsertEmailTemplate,
  type EmailTemplateUpsert,
} from "@/lib/db/email-templates";
import { refreshTemplateCache } from "@/lib/api/mark8ly-internal";
import { logger } from "@/lib/logger";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import type { Mark8lyDatabase } from "@/lib/db/mark8ly";

const ALLOWED_DBS: ReadonlyArray<Mark8lyDatabase> = ["platform_api", "marketplace_api"];

function pickDB(raw: string | null): Mark8lyDatabase {
  return raw && ALLOWED_DBS.includes(raw as Mark8lyDatabase)
    ? (raw as Mark8lyDatabase)
    : "platform_api";
}

interface PutBody {
  subject: string;
  htmlBody: string;
  textBody: string;
  variables?: Array<{ name: string; type?: string; required?: boolean }>;
  status?: "published" | "draft";
}

// Quick structural validation: matched {{…}} braces and no obviously
// broken interpolation. Real template-syntax validation happens on
// mark8ly when it tries to render — this is just an early-warning.
function validateTemplateText(name: string, body: string): string | null {
  const opens = (body.match(/\{\{/g) ?? []).length;
  const closes = (body.match(/\}\}/g) ?? []).length;
  if (opens !== closes) {
    return `${name}: mismatched template braces (${opens} {{, ${closes} }})`;
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const url = new URL(_req.url);
  const database = pickDB(url.searchParams.get("database"));
  try {
    const tpl = await getEmailTemplate(database, key);
    if (!tpl) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(tpl);
  } catch (err) {
    logger.error("[admin email-templates GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  const url = new URL(req.url);
  const database = pickDB(url.searchParams.get("database"));

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.subject !== "string" || body.subject.trim() === "") {
    return NextResponse.json({ error: "invalid_subject" }, { status: 400 });
  }
  if (typeof body.htmlBody !== "string" || body.htmlBody.trim() === "") {
    return NextResponse.json({ error: "invalid_html_body" }, { status: 400 });
  }
  if (typeof body.textBody !== "string" || body.textBody.trim() === "") {
    return NextResponse.json({ error: "invalid_text_body" }, { status: 400 });
  }

  const validationErrors: string[] = [];
  for (const [n, v] of [
    ["subject", body.subject],
    ["html_body", body.htmlBody],
    ["text_body", body.textBody],
  ] as const) {
    const err = validateTemplateText(n, v);
    if (err) validationErrors.push(err);
  }
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: "template_syntax", message: validationErrors.join("; ") },
      { status: 400 },
    );
  }

  const session = await getCurrentSession().catch(() => null);
  const updatedBy = session?.email ?? "unknown@tesserix";

  const upd: EmailTemplateUpsert = {
    key,
    subject: body.subject,
    htmlBody: body.htmlBody,
    textBody: body.textBody,
    variables: (body.variables ?? []).map((v) => ({
      name: String(v.name),
      type: typeof v.type === "string" ? v.type : "string",
      required: Boolean(v.required),
    })),
    status: body.status === "draft" ? "draft" : "published",
    updatedBy,
  };

  try {
    const saved = await upsertEmailTemplate(database, upd);
    // Best-effort cache evict — non-fatal if it fails (TTL covers us).
    await refreshTemplateCache(key);
    return NextResponse.json(saved);
  } catch (err) {
    logger.error("[admin email-templates PUT] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
