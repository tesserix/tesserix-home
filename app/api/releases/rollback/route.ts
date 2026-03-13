import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isGKE } from "@/lib/api/platform";
import { getServiceByName } from "@/lib/releases/services";
import { getRepoTags } from "@/lib/releases/github";
import { isLocked } from "@/lib/releases/deploy-lock";
import { recordEvent } from "@/lib/releases/release-events";
import {
  k8sFetch,
  knativeServicePath,
  type K8sKnativeService,
} from "@/lib/api/k8s";

const GCP_PROJECT = process.env.GCP_PROJECT_ID || "tesserix";
const GCP_REGION = process.env.GCP_REGION || "asia-south1";
const GAR_URL = `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/services`;

const KNATIVE_NAMESPACES = (
  process.env.K8S_NAMESPACES || "platform,shared,marketplace"
).split(",");

// ─── GKE (Knative) ───

async function rollbackGKE(serviceName: string, version: string): Promise<string> {
  const targetImage = `${GAR_URL}/${serviceName}:v${version}`;

  for (const ns of KNATIVE_NAMESPACES) {
    try {
      const svc = await k8sFetch<K8sKnativeService>(
        knativeServicePath(ns, serviceName)
      );

      // Update the app container image
      const container = svc.spec.template.spec.containers.find(
        (c) => c.name === serviceName || !c.name?.includes("cloud-sql-proxy")
      );
      if (container) {
        container.image = targetImage;
      }

      // Add rollback annotation
      if (!svc.spec.template.metadata) svc.spec.template.metadata = {};
      if (!svc.spec.template.metadata.annotations) svc.spec.template.metadata.annotations = {};
      svc.spec.template.metadata.annotations["tesserix.app/rolledBackAt"] = new Date().toISOString();
      svc.spec.template.metadata.annotations["tesserix.app/rolledBackTo"] = `v${version}`;

      await k8sFetch(knativeServicePath(ns, serviceName), {
        method: "PUT",
        body: JSON.stringify(svc),
      });
      return targetImage;
    } catch {
      continue;
    }
  }
  throw new Error(`Service ${serviceName} not found in any namespace`);
}

// ─── Cloud Run ───

async function rollbackCloudRun(serviceName: string, version: string): Promise<string> {
  const targetImage = `${GAR_URL}/${serviceName}:v${version}`;

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

  const containers = svcData.template?.containers ?? [];
  const appContainer = containers.find(
    (c: any) => c.name === serviceName || !c.name?.includes("cloud-sql-proxy")
  );
  if (appContainer) {
    appContainer.image = targetImage;
  }

  if (!svcData.template.annotations) svcData.template.annotations = {};
  svcData.template.annotations["tesserix.app/rolledBackAt"] = new Date().toISOString();
  svcData.template.annotations["tesserix.app/rolledBackTo"] = `v${version}`;

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
    throw new Error(`Rollback failed: ${body.slice(0, 200)}`);
  }

  return targetImage;
}

// ─── Handlers ───

/** GET — List available versions for rollback */
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const serviceName = request.nextUrl.searchParams.get("service");
    if (!serviceName) {
      return NextResponse.json({ error: "service query param is required" }, { status: 400 });
    }

    const service = getServiceByName(serviceName);
    if (!service) {
      return NextResponse.json({ error: `Unknown service: ${serviceName}` }, { status: 404 });
    }

    const tags = await getRepoTags(service.repo, { per_page: 20 });
    const versions = tags
      .filter((t) => t.name.match(/^v\d+\.\d+\.\d+$/))
      .map((t) => ({
        version: t.name.slice(1),
        tag: t.name,
        sha: t.commit.sha.slice(0, 7),
      }));

    return NextResponse.json({ data: versions });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch versions";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/** POST — Execute rollback to a specific version */
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { serviceName, version } = (await request.json()) as {
      serviceName: string;
      version: string;
    };

    if (!serviceName || !version) {
      return NextResponse.json(
        { error: "serviceName and version are required" },
        { status: 400 }
      );
    }

    const service = getServiceByName(serviceName);
    if (!service) {
      return NextResponse.json({ error: `Unknown service: ${serviceName}` }, { status: 404 });
    }

    if (isLocked(serviceName)) {
      return NextResponse.json(
        { error: `Service ${serviceName} is locked for deployments` },
        { status: 423 }
      );
    }

    const image = isGKE()
      ? await rollbackGKE(service.name, version)
      : await rollbackCloudRun(service.name, version);

    recordEvent("rollback", service.name, service.displayName, {
      toVersion: version,
    });

    return NextResponse.json({
      success: true,
      serviceName: service.name,
      version,
      image,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to rollback service";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
