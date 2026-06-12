// POST /api/contact — public contact form. Validates input and records
// the inquiry as a lead (source: contact-form) in the tesserix DB.
// Repeat submissions from the same email append to the lead's notes
// instead of failing the unique index on lower(email).

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { tesserixQuery } from "@/lib/db/tesserix";
import { logger } from "@/lib/logger";

const contactInputSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().max(100).optional().default(""),
  email: z.string().trim().toLowerCase().email("Valid email is required"),
  company: z.string().trim().max(200).optional().default(""),
  interest: z.string().trim().max(100).optional().default(""),
  message: z.string().trim().min(1, "Message is required").max(10_000),
});

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = contactInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { firstName, lastName, email, company, interest, message } =
    parsed.data;
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const note = [
    `[contact-form${interest ? ` · ${interest}` : ""}]`,
    message,
  ].join(" ");

  try {
    await tesserixQuery(
      `INSERT INTO leads (email, name, company, source, status, notes)
       VALUES ($1, $2, $3, 'contact-form', 'new', $4)
       ON CONFLICT (lower(email)) WHERE email IS NOT NULL
       DO UPDATE SET
         name    = COALESCE(NULLIF(EXCLUDED.name, ''), leads.name),
         company = COALESCE(NULLIF(EXCLUDED.company, ''), leads.company),
         notes   = COALESCE(leads.notes || E'\\n\\n', '') || EXCLUDED.notes`,
      [email, name, company || null, note],
    );

    logger.info("[Contact] inquiry recorded", { email, interest });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[Contact] failed to record inquiry", { error });
    return NextResponse.json(
      { error: "Failed to process contact request" },
      { status: 500 },
    );
  }
}
