import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, gcpApi, GCP_PROJECT, GCP_REGION } from "@/lib/api/gcp";

// ─── GCP types ───

interface GCPCondition {
  type: string;
  state: string;
  message?: string;
}

interface GCPRevision {
  name: string;
  createTime?: string;
  updateTime?: string;
  conditions?: GCPCondition[];
  containers?: Array<{
    image: string;
    env?: Array<{ name: string }>;
  }>;
  scaling?: {
    minInstanceCount?: number;
    maxInstanceCount?: number;
  };
  // Observed generation
  observedGeneration?: number;
}

interface GCPRevisionsResponse {
  revisions?: GCPRevision[];
  nextPageToken?: string;
}

interface GCPTrafficStatus {
  type?: string;
  revision?: string;
  percent?: number;
  uri?: string;
}

interface GCPService {
  name: string;
  uri?: string;
  latestReadyRevision?: string;
  trafficStatuses?: GCPTrafficStatus[];
  traffic?: Array<{ type?: string; revision?: string; percent?: number }>;
}

// ─── Response shape ───

export interface RevisionSummary {
  name: string;
  createTime: string;
  image: string;
  imageTag: string;
  minScale: number;
  maxScale: number;
  readyState: string;
  trafficPercent: number;
  isLatestReady: boolean;
  conditions: Array<{ type: string; state: string; message?: string }>;
}

function shortName(fullName: string): string {
  return fullName.split("/").pop() ?? fullName;
}

function extractImageTag(image: string): string {
  const colonIdx = image.lastIndexOf(":");
  if (colonIdx === -1) return image.split("/").pop() ?? image;
  const tag = image.slice(colonIdx + 1);
  if (tag.startsWith("sha256-")) return tag.slice(0, 19);
  return tag;
}

function revisionReadyState(conditions: GCPCondition[]): string {
  const ready = conditions.find((c) => c.type === "Ready");
  if (!ready) return "Unknown";
  if (ready.state === "CONDITION_SUCCEEDED") return "Ready";
  if (ready.state === "CONDITION_FAILED") return "Failed";
  if (ready.state === "CONDITION_PENDING") return "Pending";
  return "Unknown";
}

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

    // Fetch service and revisions in parallel
    const [svc, revisionsResponse] = await Promise.all([
      gcpApi<GCPService>(
        `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${name}`,
        token
      ),
      gcpApi<GCPRevisionsResponse>(
        `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${name}/revisions?pageSize=20`,
        token
      ),
    ]);

    const latestReadyRevision = svc.latestReadyRevision
      ? shortName(svc.latestReadyRevision)
      : "";

    // Build traffic percent map from trafficStatuses (actual) or traffic (configured)
    const trafficMap = new Map<string, number>();
    for (const t of svc.trafficStatuses ?? svc.traffic ?? []) {
      const revName = t.revision ? shortName(t.revision) : "";
      if (revName) {
        trafficMap.set(revName, (trafficMap.get(revName) ?? 0) + (t.percent ?? 0));
      }
    }

    const revisions: RevisionSummary[] = (revisionsResponse.revisions ?? []).map((rev) => {
      const revShortName = shortName(rev.name);
      const container = rev.containers?.[0];
      const image = container?.image ?? "";
      const conditions = rev.conditions ?? [];

      return {
        name: revShortName,
        createTime: rev.createTime ?? "",
        image,
        imageTag: extractImageTag(image),
        minScale: rev.scaling?.minInstanceCount ?? 0,
        maxScale: rev.scaling?.maxInstanceCount ?? 100,
        readyState: revisionReadyState(conditions),
        trafficPercent: trafficMap.get(revShortName) ?? 0,
        isLatestReady: revShortName === latestReadyRevision,
        conditions: conditions.map((c) => ({
          type: c.type,
          state: c.state,
          message: c.message,
        })),
      };
    });

    return NextResponse.json({
      data: {
        name,
        uri: svc.uri ?? "",
        latestReadyRevision,
        revisions,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch service revisions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
