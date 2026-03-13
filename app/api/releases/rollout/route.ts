import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isGKE } from "@/lib/api/platform";
import { getServiceByName } from "@/lib/releases/services";
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

// ─── GKE (Knative) ───

async function rolloutGKE(serviceName: string): Promise<void> {
  for (const ns of KNATIVE_NAMESPACES) {
    try {
      const svc = await k8sFetch<K8sKnativeService>(
        knativeServicePath(ns, serviceName)
      );

      // Force new revision by updating a template annotation
      if (!svc.spec.template.metadata) svc.spec.template.metadata = {};
      if (!svc.spec.template.metadata.annotations) svc.spec.template.metadata.annotations = {};
      svc.spec.template.metadata.annotations["client.knative.dev/restartedAt"] =
        new Date().toISOString();

      await k8sFetch(knativeServicePath(ns, serviceName), {
        method: "PUT",
        body: JSON.stringify(svc),
      });
      return;
    } catch {
      continue;
    }
  }
  throw new Error(`Service ${serviceName} not found in any namespace`);
}

// ─── Cloud Run ───

async function rolloutCloudRun(serviceName: string): Promise<void> {
  const tokenRes = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );

  if (!tokenRes.ok) {
    throw new Error("Failed to get GCP access token (not running on Cloud Run?)");
  }

  const { access_token } = await tokenRes.json();

  const getRes = await fetch(
    `https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${serviceName}`,
    { headers: { Authorization: `Bearer ${access_token}` } }
  );

  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`Cloud Run API error: ${body.slice(0, 200)}`);
  }

  const svcData = await getRes.json();

  const annotations = svcData.template?.metadata?.annotations || {};
  annotations["client.knative.dev/restartedAt"] = new Date().toISOString();
  if (!svcData.template) svcData.template = {};
  if (!svcData.template.metadata) svcData.template.metadata = {};
  svcData.template.metadata.annotations = annotations;

  const updateRes = await fetch(
    `https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${serviceName}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(svcData),
    }
  );

  if (!updateRes.ok) {
    const body = await updateRes.text();
    throw new Error(`Restart failed: ${body.slice(0, 200)}`);
  }
}

// ─── Handler ───

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { serviceName } = (await request.json()) as { serviceName: string };
    if (!serviceName) {
      return NextResponse.json({ error: "serviceName is required" }, { status: 400 });
    }

    const service = getServiceByName(serviceName);
    if (!service) {
      return NextResponse.json({ error: `Unknown service: ${serviceName}` }, { status: 404 });
    }

    if (isGKE()) {
      await rolloutGKE(service.name);
    } else {
      await rolloutCloudRun(service.name);
    }

    return NextResponse.json({ success: true, serviceName: service.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to restart service";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
