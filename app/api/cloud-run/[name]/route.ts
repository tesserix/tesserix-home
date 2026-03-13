import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isGKE } from "@/lib/api/platform";
import { getAccessToken, gcpApi, GCP_PROJECT, GCP_REGION } from "@/lib/api/gcp";
import {
  k8sFetch,
  knativeServicePath,
  knativeRevisionsPath,
  K8S_NAMESPACE,
  type K8sKnativeService,
  type K8sKnativeRevision,
} from "@/lib/api/k8s";

// ─── Shared response shape ───

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

// ─── GKE (Knative) ───

const KNATIVE_NAMESPACES = (
  process.env.K8S_NAMESPACES || "platform,shared,marketplace"
).split(",");

async function findKnativeServiceNamespace(name: string): Promise<string | null> {
  for (const ns of KNATIVE_NAMESPACES) {
    try {
      await k8sFetch<K8sKnativeService>(knativeServicePath(ns, name));
      return ns;
    } catch {
      continue;
    }
  }
  return null;
}

async function getServiceDetailGKE(name: string) {
  const ns = await findKnativeServiceNamespace(name);
  if (!ns) throw new Error(`Service ${name} not found in any namespace`);

  const [svc, revisionsResp] = await Promise.all([
    k8sFetch<K8sKnativeService>(knativeServicePath(ns, name)),
    k8sFetch<{ items?: K8sKnativeRevision[] }>(
      `${knativeRevisionsPath(ns)}?labelSelector=serving.knative.dev/service=${name}`
    ),
  ]);

  const latestReady = svc.status.latestReadyRevisionName ?? "";
  const trafficMap = new Map<string, number>();
  for (const t of svc.status.traffic ?? []) {
    if (t.revisionName) {
      trafficMap.set(t.revisionName, (trafficMap.get(t.revisionName) ?? 0) + (t.percent ?? 0));
    }
  }

  const revisions: RevisionSummary[] = (revisionsResp.items ?? [])
    .sort((a, b) => (b.metadata.creationTimestamp ?? "").localeCompare(a.metadata.creationTimestamp ?? ""))
    .slice(0, 20)
    .map((rev) => {
      const container = rev.spec.containers?.[0];
      const image = container?.image ?? "";
      const conditions = rev.status.conditions ?? [];
      const readyCond = conditions.find((c) => c.type === "Ready");

      const annotations = rev.metadata.annotations ?? {};
      const minScale = parseInt(annotations["autoscaling.knative.dev/minScale"] ?? "0", 10);
      const maxScale = parseInt(annotations["autoscaling.knative.dev/maxScale"] ?? "100", 10);

      return {
        name: rev.metadata.name,
        createTime: rev.metadata.creationTimestamp ?? "",
        image,
        imageTag: extractImageTag(image),
        minScale,
        maxScale,
        readyState: readyCond?.status === "True" ? "Ready" : readyCond?.status === "False" ? "Failed" : "Pending",
        trafficPercent: trafficMap.get(rev.metadata.name) ?? 0,
        isLatestReady: rev.metadata.name === latestReady,
        conditions: conditions.map((c) => ({
          type: c.type,
          state: c.status === "True" ? "CONDITION_SUCCEEDED" : c.status === "False" ? "CONDITION_FAILED" : "CONDITION_PENDING",
          message: c.message,
        })),
      };
    });

  return {
    name,
    uri: svc.status.url ?? "",
    latestReadyRevision: latestReady,
    revisions,
  };
}

// ─── Cloud Run ───

interface GCPCondition { type: string; state: string; message?: string }

interface GCPService {
  name: string;
  uri?: string;
  latestReadyRevision?: string;
  trafficStatuses?: Array<{ revision?: string; percent?: number }>;
  traffic?: Array<{ revision?: string; percent?: number }>;
}

interface GCPRevision {
  name: string;
  createTime?: string;
  conditions?: GCPCondition[];
  containers?: Array<{ image: string }>;
  scaling?: { minInstanceCount?: number; maxInstanceCount?: number };
}

async function getServiceDetailCloudRun(name: string) {
  const token = await getAccessToken();

  const [svc, revisionsResponse] = await Promise.all([
    gcpApi<GCPService>(
      `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${name}`,
      token
    ),
    gcpApi<{ revisions?: GCPRevision[] }>(
      `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${name}/revisions?pageSize=20`,
      token
    ),
  ]);

  const latestReadyRevision = svc.latestReadyRevision ? shortName(svc.latestReadyRevision) : "";

  const trafficMap = new Map<string, number>();
  for (const t of svc.trafficStatuses ?? svc.traffic ?? []) {
    const revName = t.revision ? shortName(t.revision) : "";
    if (revName) trafficMap.set(revName, (trafficMap.get(revName) ?? 0) + (t.percent ?? 0));
  }

  const revisions: RevisionSummary[] = (revisionsResponse.revisions ?? []).map((rev) => {
    const revShortName = shortName(rev.name);
    const container = rev.containers?.[0];
    const image = container?.image ?? "";
    const conditions = rev.conditions ?? [];
    const ready = conditions.find((c) => c.type === "Ready");

    return {
      name: revShortName,
      createTime: rev.createTime ?? "",
      image,
      imageTag: extractImageTag(image),
      minScale: rev.scaling?.minInstanceCount ?? 0,
      maxScale: rev.scaling?.maxInstanceCount ?? 100,
      readyState: !ready ? "Unknown" : ready.state === "CONDITION_SUCCEEDED" ? "Ready" : ready.state === "CONDITION_FAILED" ? "Failed" : "Pending",
      trafficPercent: trafficMap.get(revShortName) ?? 0,
      isLatestReady: revShortName === latestReadyRevision,
      conditions: conditions.map((c) => ({ type: c.type, state: c.state, message: c.message })),
    };
  });

  return { name, uri: svc.uri ?? "", latestReadyRevision, revisions };
}

// ─── Handler ───

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
    const data = isGKE()
      ? await getServiceDetailGKE(name)
      : await getServiceDetailCloudRun(name);

    return NextResponse.json({ data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch service revisions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
