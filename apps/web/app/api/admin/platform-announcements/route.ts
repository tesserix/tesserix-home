import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createAnnouncement, listAnnouncements } from "@/lib/db/platform-announcements";
import { logger } from "@/lib/logger";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  severity: z.enum(["info", "warning", "maintenance", "incident"]).optional(),
  audienceFilter: z.record(z.string(), z.unknown()).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().nullable().optional(),
  isPublished: z.boolean().optional(),
});

export async function GET() {
  try {
    const rows = await listAnnouncements();
    return NextResponse.json({ rows, generatedAt: new Date().toISOString() });
  } catch (err) {
    logger.error("[platform-announcements list] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_payload", details: parsed.error.format() },
      { status: 400 },
    );
  }
  try {
    const row = await createAnnouncement(parsed.data);
    return NextResponse.json({ announcement: row }, { status: 201 });
  } catch (err) {
    logger.error("[platform-announcements create] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
