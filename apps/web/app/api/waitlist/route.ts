// POST /api/waitlist — public "notify me when this launches" signup.
//
// The product page's "Get notified when we launch" button used to be a link to
// /contact, which recorded nothing and left us with no list to mail on launch
// day. This is where it writes to now.
//
// Signup is idempotent per (product, email): a double-tap, or someone coming
// back a month later, is the same intent restated — never an error.

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { subscribeToWaitlist } from "@/lib/db/product-waitlist";
import { logger } from "@/lib/logger";
import { productSlugs } from "@/app/(marketing)/products/[slug]/products-data";

const waitlistInputSchema = z.object({
  // Constrained to real product slugs so the table cannot be seeded with
  // arbitrary keys that no launch would ever match.
  productSlug: z.string().trim().min(1).max(64),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  name: z.string().trim().max(120).optional().default(""),
  source: z.string().trim().max(60).optional(),
});

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = waitlistInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 },
    );
  }

  const { productSlug, email, name, source } = parsed.data;

  if (!productSlugs.includes(productSlug)) {
    return NextResponse.json({ error: "Unknown product" }, { status: 404 });
  }

  try {
    await subscribeToWaitlist({ productSlug, email, name, source });
    // Product + outcome only — never the address, which is the PII here.
    logger.info("[Waitlist] signup recorded", { productSlug });
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("[Waitlist] failed to record signup", { error, productSlug });
    return NextResponse.json(
      { error: "Could not add you to the list. Please try again." },
      { status: 500 },
    );
  }
}
