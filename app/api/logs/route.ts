import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, gcpFetch, GCP_PROJECT } from "@/lib/api/gcp";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const service = searchParams.get("service");
  const severity = searchParams.get("severity") || "DEFAULT";
  const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
  const pageToken = searchParams.get("pageToken") || undefined;

  if (!service) {
    return NextResponse.json({ error: "service param required" }, { status: 400 });
  }

  try {
    const token = await getAccessToken();

    let filter = `resource.type="cloud_run_revision" resource.labels.service_name="${service}"`;
    if (severity && severity !== "DEFAULT") {
      filter += ` severity>=${severity}`;
    }

    const body: Record<string, unknown> = {
      resourceNames: [`projects/${GCP_PROJECT}`],
      filter,
      orderBy: "timestamp desc",
      pageSize: limit,
    };
    if (pageToken) body.pageToken = pageToken;

    const data = await gcpFetch<{
      entries?: Array<{
        insertId: string;
        timestamp: string;
        severity: string;
        textPayload?: string;
        jsonPayload?: Record<string, unknown>;
        httpRequest?: { requestMethod: string; requestUrl: string; status: number };
        resource: { labels: Record<string, string> };
        labels?: Record<string, string>;
      }>;
      nextPageToken?: string;
    }>("https://logging.googleapis.com/v2/entries:list", token, {
      method: "POST",
      body: JSON.stringify(body),
    });

    const entries = (data.entries ?? []).map((e) => ({
      insertId: e.insertId,
      timestamp: e.timestamp,
      severity: e.severity || "DEFAULT",
      message:
        e.textPayload ||
        (e.jsonPayload?.message as string) ||
        (e.jsonPayload?.msg as string) ||
        JSON.stringify(e.jsonPayload ?? {}),
      revision: e.resource?.labels?.revision_name,
    }));

    return NextResponse.json({
      entries,
      nextPageToken: data.nextPageToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
