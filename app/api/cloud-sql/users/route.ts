import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, gcpFetch, GCP_PROJECT } from "@/lib/api/gcp";

interface SqlUser {
  name: string;
  host?: string;
  type?: string;
  instance?: string;
}

interface SqlUsersResponse {
  items?: SqlUser[];
}

// ─── GET /api/cloud-sql/users?instance=INSTANCE_NAME ───

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const instance = request.nextUrl.searchParams.get("instance");
    if (!instance) {
      return NextResponse.json({ error: "instance query param is required" }, { status: 400 });
    }

    const token = await getAccessToken();
    const data = await gcpFetch<SqlUsersResponse>(
      `https://sqladmin.googleapis.com/v1/projects/${GCP_PROJECT}/instances/${instance}/users`,
      token
    );

    const users = (data.items || [])
      .filter((u) => u.name !== "cloudsqladmin")
      .map((u) => ({
        name: u.name,
        host: u.host || "%",
        type: u.type || "BUILT_IN",
      }));

    return NextResponse.json({ data: users });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch Cloud SQL users";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
