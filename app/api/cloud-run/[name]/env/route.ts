import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, gcpApi, GCP_PROJECT, GCP_REGION } from "@/lib/api/gcp";

interface GCPEnvVar {
  name: string;
  value?: string;
  valueSource?: unknown;
}

interface GCPContainer {
  image?: string;
  env?: GCPEnvVar[];
}

interface GCPRevisionTemplate {
  containers?: GCPContainer[];
}

interface GCPService {
  name: string;
  template?: GCPRevisionTemplate;
  latestReadyRevision?: string;
}

/**
 * GET /api/cloud-run/[name]/env
 * Returns only the names of env vars configured on the latest container spec.
 * Values are intentionally omitted for security.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name } = await params;
    const token = await getAccessToken();

    const svc = await gcpApi<GCPService>(
      `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${name}`,
      token
    );

    const envVars = svc.template?.containers?.[0]?.env ?? [];

    // Return names only — never values
    const names = envVars
      .map((e) => e.name)
      .filter(Boolean)
      .sort();

    return NextResponse.json({
      data: {
        serviceName: name,
        envVarNames: names,
        count: names.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch env vars";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
