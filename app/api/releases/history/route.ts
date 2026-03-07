import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getEvents } from "@/lib/releases/release-events";

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({
      data: getEvents(),
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch release history";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
