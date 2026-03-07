import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SERVICE_REGISTRY } from "@/lib/releases/services";

const GCP_PROJECT = process.env.GCP_PROJECT_ID || "tesserix";
const GCP_REGION = process.env.GCP_REGION || "asia-south1";

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

async function getServiceHealth(
  serviceName: string,
  displayName: string,
  accessToken: string
): Promise<ServiceHealth> {
  const fallback: ServiceHealth = {
    name: serviceName,
    displayName,
    status: "unknown",
    instanceCount: 0,
    maxInstances: 0,
    latestRevision: "",
    latestImage: "",
    url: "",
    lastDeployedAt: null,
  };

  try {
    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${serviceName}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) return fallback;

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
    return fallback;
  }
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const accessToken = await getAccessToken();

    if (!accessToken) {
      // Not running on Cloud Run — return unknown status for all services
      const data = SERVICE_REGISTRY.filter((s) => s.managed).map((svc) => ({
        name: svc.name,
        displayName: svc.displayName,
        status: "unknown" as const,
        instanceCount: 0,
        maxInstances: 0,
        latestRevision: "",
        latestImage: "",
        url: "",
        lastDeployedAt: null,
      }));

      return NextResponse.json({
        data,
        available: false,
        lastUpdated: new Date().toISOString(),
      });
    }

    // Fetch health for all managed services in parallel
    const managedServices = SERVICE_REGISTRY.filter((s) => s.managed);
    const results = await Promise.allSettled(
      managedServices.map((svc) =>
        getServiceHealth(svc.name, svc.displayName, accessToken)
      )
    );

    const data = results.map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      return {
        name: managedServices[i].name,
        displayName: managedServices[i].displayName,
        status: "unknown" as const,
        instanceCount: 0,
        maxInstances: 0,
        latestRevision: "",
        latestImage: "",
        url: "",
        lastDeployedAt: null,
      };
    });

    return NextResponse.json({
      data,
      available: true,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch health";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
