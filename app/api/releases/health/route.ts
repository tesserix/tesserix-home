import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isGKE } from "@/lib/api/platform";
import { SERVICE_REGISTRY } from "@/lib/releases/services";
import {
  k8sFetch,
  knativeServicePath,
  type K8sKnativeService,
} from "@/lib/api/k8s";

const GCP_PROJECT = process.env.GCP_PROJECT_ID || "tesserix";
const GCP_REGION = process.env.GCP_REGION || "asia-south1";

const KNATIVE_NAMESPACES = (
  process.env.K8S_NAMESPACES || "platform,shared,marketplace"
).split(",");

interface ServiceHealth {
  name: string;
  displayName: string;
  status: "healthy" | "degraded" | "unknown";
  instanceCount: number;
  maxInstances: number;
  latestRevision: string;
  latestImage: string;
  url: string;
  lastDeployedAt: string | null;
}

const UNKNOWN_HEALTH = (name: string, displayName: string): ServiceHealth => ({
  name,
  displayName,
  status: "unknown",
  instanceCount: 0,
  maxInstances: 0,
  latestRevision: "",
  latestImage: "",
  url: "",
  lastDeployedAt: null,
});

// ─── GKE (Knative) ───

async function getHealthGKE(
  serviceName: string,
  displayName: string
): Promise<ServiceHealth> {
  for (const ns of KNATIVE_NAMESPACES) {
    try {
      const svc = await k8sFetch<K8sKnativeService>(
        knativeServicePath(ns, serviceName)
      );

      const conditions = svc.status.conditions ?? [];
      const readyCond = conditions.find((c) => c.type === "Ready");
      const isReady = readyCond?.status === "True";

      const container = svc.spec.template.spec.containers.find(
        (c) => !c.name?.includes("cloud-sql-proxy")
      );

      const annotations = svc.spec.template.metadata?.annotations ?? {};
      const minScale = parseInt(annotations["autoscaling.knative.dev/minScale"] ?? "0", 10);
      const maxScale = parseInt(annotations["autoscaling.knative.dev/maxScale"] ?? "100", 10);

      const lastTransition = conditions
        .map((c) => c.lastTransitionTime)
        .filter(Boolean)
        .sort()
        .pop();

      return {
        name: serviceName,
        displayName,
        status: isReady ? "healthy" : "degraded",
        instanceCount: minScale,
        maxInstances: maxScale,
        latestRevision: svc.status.latestReadyRevisionName ?? "",
        latestImage: container?.image ?? "",
        url: svc.status.url ?? "",
        lastDeployedAt: lastTransition ?? null,
      };
    } catch {
      continue;
    }
  }
  return UNKNOWN_HEALTH(serviceName, displayName);
}

// ─── Cloud Run ───

async function getAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }
    );
    if (!res.ok) return null;
    const { access_token } = await res.json();
    return access_token;
  } catch {
    return null;
  }
}

async function getHealthCloudRun(
  serviceName: string,
  displayName: string,
  accessToken: string
): Promise<ServiceHealth> {
  try {
    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${serviceName}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) return UNKNOWN_HEALTH(serviceName, displayName);

    const data = await res.json();
    const conditions = data.conditions ?? data.status?.conditions ?? [];
    const ready = conditions.find((c: any) => c.type === "Ready");
    const isReady = ready?.status === "True";

    const containers = data.template?.containers ?? [];
    const appContainer = containers.find(
      (c: any) => !c.name?.includes("cloud-sql-proxy")
    );

    const scaling = data.template?.scaling ?? {};

    return {
      name: serviceName,
      displayName,
      status: isReady ? "healthy" : "degraded",
      instanceCount: scaling.minInstanceCount ?? 0,
      maxInstances: scaling.maxInstanceCount ?? 0,
      latestRevision: data.latestReadyRevision?.split("/").pop() ?? "",
      latestImage: appContainer?.image ?? "",
      url: data.uri ?? "",
      lastDeployedAt: data.updateTime ?? null,
    };
  } catch {
    return UNKNOWN_HEALTH(serviceName, displayName);
  }
}

// ─── Handler ───

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const managedServices = SERVICE_REGISTRY.filter((s) => s.managed);

    if (isGKE()) {
      const results = await Promise.allSettled(
        managedServices.map((svc) => getHealthGKE(svc.name, svc.displayName))
      );

      const data = results.map((result, i) =>
        result.status === "fulfilled"
          ? result.value
          : UNKNOWN_HEALTH(managedServices[i].name, managedServices[i].displayName)
      );

      return NextResponse.json({
        data,
        available: true,
        lastUpdated: new Date().toISOString(),
      });
    }

    // Cloud Run path
    const accessToken = await getAccessToken();

    if (!accessToken) {
      const data = managedServices.map((svc) =>
        UNKNOWN_HEALTH(svc.name, svc.displayName)
      );
      return NextResponse.json({
        data,
        available: false,
        lastUpdated: new Date().toISOString(),
      });
    }

    const results = await Promise.allSettled(
      managedServices.map((svc) =>
        getHealthCloudRun(svc.name, svc.displayName, accessToken)
      )
    );

    const data = results.map((result, i) =>
      result.status === "fulfilled"
        ? result.value
        : UNKNOWN_HEALTH(managedServices[i].name, managedServices[i].displayName)
    );

    return NextResponse.json({
      data,
      available: true,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch health";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
