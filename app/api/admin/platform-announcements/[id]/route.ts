import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { updateAnnouncementPublished } from "@/lib/db/platform-announcements";
import { logger } from "@/lib/logger";

const patchSchema = z.object({ isPublished: z.boolean() });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  try {
    const row = await updateAnnouncementPublished(id, parsed.data.isPublished);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ announcement: row });
  } catch (err) {
    logger.error("[announcement patch] failed", err);
    return NextResponse.json({ error: "db_unavailable" }, { status: 500 });
  }
}
