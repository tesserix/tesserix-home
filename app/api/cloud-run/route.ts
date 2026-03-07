import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAccessToken, gcpApi, GCP_PROJECT, GCP_REGION } from "@/lib/api/gcp";

// ─── GCP Cloud Run API types ───

interface GCPCondition {
  type: string;
  state: string;
  message?: string;
  lastTransitionTime?: string;
}

interface GCPContainer {
  image: string;
  env?: Array<{ name: string; value?: string; valueSource?: unknown }>;
}

interface GCPRevisionTemplate {
  scaling?: {
    minInstanceCount?: number;
    maxInstanceCount?: number;
  };
  containers?: GCPContainer[];
}

interface GCPTrafficStatus {
  type?: string;
  revision?: string;
  percent?: number;
  uri?: string;
}

interface GCPService {
  name: string;
  uid?: string;
  generation?: number;
  createTime?: string;
  updateTime?: string;
  creator?: string;
  uri?: string;
  latestReadyRevision?: string;
  latestCreatedRevision?: string;
  conditions?: GCPCondition[];
  template?: GCPRevisionTemplate;
  traffic?: Array<{ type?: string; percent?: number }>;
  trafficStatuses?: GCPTrafficStatus[];
}

interface GCPServicesResponse {
  services?: GCPService[];
  nextPageToken?: string;
}

// ─── Response shape ───

export interface CloudRunServiceSummary {
  name: string;
  displayName: string;
  generation: number;
  creator: string;
  createTime: string;
  updateTime: string;
  uri: string;
  latestReadyRevision: string;
  servingStatus: "Serving" | "Deploying" | "Failed" | "Unknown";
  routingStatus: "Active" | "Inactive" | "Unknown";
  conditions: Array<{ type: string; state: string; message?: string }>;
  minScale: number;
  maxScale: number;
  image: string;
  imageTag: string;
  envVarCount: number;
}

function deriveServingStatus(conditions: GCPCondition[]): CloudRunServiceSummary["servingStatus"] {
  const ready = conditions.find((c) => c.type === "Ready");
  if (!ready) return "Unknown";
  if (ready.state === "CONDITION_SUCCEEDED") return "Serving";
  if (ready.state === "CONDITION_FAILED") return "Failed";
  if (ready.state === "CONDITION_PENDING") return "Deploying";
  return "Unknown";
}

function deriveRoutingStatus(conditions: GCPCondition[]): CloudRunServiceSummary["routingStatus"] {
  const routing = conditions.find((c) => c.type === "RoutesReady");
  if (!routing) return "Unknown";
  if (routing.state === "CONDITION_SUCCEEDED") return "Active";
  if (routing.state === "CONDITION_FAILED") return "Inactive";
  return "Unknown";
}

function extractImageTag(image: string): string {
  // e.g. us-central1-docker.pkg.dev/project/repo/service:sha256-abc or :v1.2.3
  const colonIdx = image.lastIndexOf(":");
  if (colonIdx === -1) return image.split("/").pop() ?? image;
  const tag = image.slice(colonIdx + 1);
  // If it's a sha256 digest, shorten it
  if (tag.startsWith("sha256-")) return tag.slice(0, 19); // sha256-abcdef12
  return tag;
}

function shortServiceName(fullName: string): string {
  // projects/{proj}/locations/{region}/services/{name}
  return fullName.split("/").pop() ?? fullName;
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = await getAccessToken();

    const response = await gcpApi<GCPServicesResponse>(
      `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services`,
      token
    );

    const services: CloudRunServiceSummary[] = (response.services ?? []).map((svc) => {
      const conditions = svc.conditions ?? [];
      const container = svc.template?.containers?.[0];
      const image = container?.image ?? "";
      const envVarCount = container?.env?.length ?? 0;

      return {
        name: shortServiceName(svc.name),
        displayName: shortServiceName(svc.name),
        generation: svc.generation ?? 0,
        creator: svc.creator ?? "",
        createTime: svc.createTime ?? "",
        updateTime: svc.updateTime ?? "",
        uri: svc.uri ?? "",
        latestReadyRevision: svc.latestReadyRevision
          ? shortServiceName(svc.latestReadyRevision)
          : "",
        servingStatus: deriveServingStatus(conditions),
        routingStatus: deriveRoutingStatus(conditions),
        conditions: conditions.map((c) => ({
          type: c.type,
          state: c.state,
          message: c.message,
        })),
        minScale: svc.template?.scaling?.minInstanceCount ?? 0,
        maxScale: svc.template?.scaling?.maxInstanceCount ?? 100,
        image,
        imageTag: extractImageTag(image),
        envVarCount,
      };
    });

    // Sort alphabetically by name
    services.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ data: services });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch Cloud Run services";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
