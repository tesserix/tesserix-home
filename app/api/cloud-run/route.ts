import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isGKE } from "@/lib/api/platform";
import { getAccessToken, gcpApi, GCP_PROJECT, GCP_REGION } from "@/lib/api/gcp";
import {
  k8sFetch,
  knativeServicesPath,
  type K8sKnativeService,
} from "@/lib/api/k8s";

// ─── Shared response shape (frontend depends on this) ───

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

function extractImageTag(image: string): string {
  const colonIdx = image.lastIndexOf(":");
  if (colonIdx === -1) return image.split("/").pop() ?? image;
  const tag = image.slice(colonIdx + 1);
  if (tag.startsWith("sha256-")) return tag.slice(0, 19);
  return tag;
}

function shortName(fullName: string): string {
  return fullName.split("/").pop() ?? fullName;
}

// ─── GKE (Knative) ───

const KNATIVE_NAMESPACES = (
  process.env.K8S_NAMESPACES || "platform,shared,marketplace"
).split(",");

async function listServicesGKE(): Promise<CloudRunServiceSummary[]> {
  const results: CloudRunServiceSummary[] = [];

  for (const ns of KNATIVE_NAMESPACES) {
    const resp = await k8sFetch<{ items?: K8sKnativeService[] }>(
      knativeServicesPath(ns)
    );

    for (const svc of resp.items ?? []) {
      const container = svc.spec.template.spec.containers[0];
      const image = container?.image ?? "";
      const conditions = svc.status.conditions ?? [];
      const readyCond = conditions.find((c) => c.type === "Ready");
      const routeCond = conditions.find((c) => c.type === "RoutesReady");

      const annotations = svc.spec.template.metadata?.annotations ?? {};
      const minScale = parseInt(annotations["autoscaling.knative.dev/minScale"] ?? "0", 10);
      const maxScale = parseInt(annotations["autoscaling.knative.dev/maxScale"] ?? "100", 10);

      results.push({
        name: svc.metadata.name,
        displayName: svc.metadata.name,
        generation: svc.metadata.generation ?? 0,
        creator: svc.metadata.annotations?.["serving.knative.dev/creator"] ?? "",
        createTime: svc.metadata.creationTimestamp ?? "",
        updateTime:
          conditions.find((c) => c.type === "Ready")?.lastTransitionTime ?? "",
        uri: svc.status.url ?? "",
        latestReadyRevision: svc.status.latestReadyRevisionName ?? "",
        servingStatus: deriveKnativeServingStatus(readyCond),
        routingStatus: deriveKnativeRouteStatus(routeCond),
        conditions: conditions.map((c) => ({
          type: c.type,
          state: c.status === "True" ? "CONDITION_SUCCEEDED" : c.status === "False" ? "CONDITION_FAILED" : "CONDITION_PENDING",
          message: c.message,
        })),
        minScale,
        maxScale,
        image,
        imageTag: extractImageTag(image),
        envVarCount: container?.env?.length ?? 0,
      });
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

function deriveKnativeServingStatus(
  cond?: { status: string }
): CloudRunServiceSummary["servingStatus"] {
  if (!cond) return "Unknown";
  if (cond.status === "True") return "Serving";
  if (cond.status === "False") return "Failed";
  return "Deploying";
}

function deriveKnativeRouteStatus(
  cond?: { status: string }
): CloudRunServiceSummary["routingStatus"] {
  if (!cond) return "Unknown";
  if (cond.status === "True") return "Active";
  if (cond.status === "False") return "Inactive";
  return "Unknown";
}

// ─── Cloud Run (existing) ───

interface GCPCondition {
  type: string;
  state: string;
  message?: string;
}

interface GCPService {
  name: string;
  generation?: number;
  createTime?: string;
  updateTime?: string;
  creator?: string;
  uri?: string;
  latestReadyRevision?: string;
  conditions?: GCPCondition[];
  template?: {
    scaling?: { minInstanceCount?: number; maxInstanceCount?: number };
    containers?: Array<{
      image: string;
      env?: Array<{ name: string }>;
    }>;
  };
}

async function listServicesCloudRun(): Promise<CloudRunServiceSummary[]> {
  const token = await getAccessToken();
  const response = await gcpApi<{ services?: GCPService[] }>(
    `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services`,
    token
  );

  const services: CloudRunServiceSummary[] = (response.services ?? []).map((svc) => {
    const conditions = svc.conditions ?? [];
    const container = svc.template?.containers?.[0];
    const image = container?.image ?? "";

    return {
      name: shortName(svc.name),
      displayName: shortName(svc.name),
      generation: svc.generation ?? 0,
      creator: svc.creator ?? "",
      createTime: svc.createTime ?? "",
      updateTime: svc.updateTime ?? "",
      uri: svc.uri ?? "",
      latestReadyRevision: svc.latestReadyRevision
        ? shortName(svc.latestReadyRevision)
        : "",
      servingStatus: deriveCRServingStatus(conditions),
      routingStatus: deriveCRRoutingStatus(conditions),
      conditions: conditions.map((c) => ({
        type: c.type,
        state: c.state,
        message: c.message,
      })),
      minScale: svc.template?.scaling?.minInstanceCount ?? 0,
      maxScale: svc.template?.scaling?.maxInstanceCount ?? 100,
      image,
      imageTag: extractImageTag(image),
      envVarCount: container?.env?.length ?? 0,
    };
  });

  services.sort((a, b) => a.name.localeCompare(b.name));
  return services;
}

function deriveCRServingStatus(conditions: GCPCondition[]): CloudRunServiceSummary["servingStatus"] {
  const ready = conditions.find((c) => c.type === "Ready");
  if (!ready) return "Unknown";
  if (ready.state === "CONDITION_SUCCEEDED") return "Serving";
  if (ready.state === "CONDITION_FAILED") return "Failed";
  if (ready.state === "CONDITION_PENDING") return "Deploying";
  return "Unknown";
}

function deriveCRRoutingStatus(conditions: GCPCondition[]): CloudRunServiceSummary["routingStatus"] {
  const routing = conditions.find((c) => c.type === "RoutesReady");
  if (!routing) return "Unknown";
  if (routing.state === "CONDITION_SUCCEEDED") return "Active";
  if (routing.state === "CONDITION_FAILED") return "Inactive";
  return "Unknown";
}

// ─── Handler ───

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const services = isGKE()
      ? await listServicesGKE()
      : await listServicesCloudRun();

    return NextResponse.json({ data: services });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch services";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
