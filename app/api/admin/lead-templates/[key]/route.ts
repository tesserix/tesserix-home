// B2 — Lead templates GET + PUT (upsert).
import { NextResponse, type NextRequest } from "next/server";
import {
  getLeadTemplate,
  upsertLeadTemplate,
  type LeadTemplateUpsert,
} from "@/lib/db/lead-templates";
import { getCurrentSession } from "@/lib/auth/session-jwt";
import { logger } from "@/lib/logger";

interface PutBody {
  label?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  variables?: Array<{ name: string; type?: string; required?: boolean }>;
  status?: "published" | "draft";
  product?: string;
}

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
  try {
    const tpl = await getLeadTemplate(key);
    if (!tpl) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(tpl);
  } catch (err) {
    logger.error("[admin lead-templates GET] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params;
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.label || !body.subject || !body.htmlBody || !body.textBody) {
    return NextResponse.json(
      { error: "missing_fields", message: "label, subject, htmlBody, textBody required" },
      { status: 400 },
    );
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

  const upd: LeadTemplateUpsert = {
    key,
    label: body.label,
    subject: body.subject,
    htmlBody: body.htmlBody,
    textBody: body.textBody,
    variables: (body.variables ?? []).map((v) => ({
      name: String(v.name),
      type: typeof v.type === "string" ? v.type : "string",
      required: Boolean(v.required),
    })),
    status: body.status === "draft" ? "draft" : "published",
    product: body.product ?? "",
    updatedBy,
  };

  try {
    const saved = await upsertLeadTemplate(upd);
    return NextResponse.json(saved);
  } catch (err) {
    logger.error("[admin lead-templates PUT] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
