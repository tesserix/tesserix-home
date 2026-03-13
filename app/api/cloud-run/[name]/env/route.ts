import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { isGKE } from "@/lib/api/platform";
import { getAccessToken, gcpApi, GCP_PROJECT, GCP_REGION } from "@/lib/api/gcp";
import {
  k8sFetch,
  knativeServicePath,
  type K8sKnativeService,
} from "@/lib/api/k8s";

const KNATIVE_NAMESPACES = (
  process.env.K8S_NAMESPACES || "platform,shared,marketplace"
).split(",");

// ─── GKE ───

async function getEnvNamesGKE(name: string): Promise<string[]> {
  for (const ns of KNATIVE_NAMESPACES) {
    try {
      const svc = await k8sFetch<K8sKnativeService>(knativeServicePath(ns, name));
      const envVars = svc.spec.template.spec.containers[0]?.env ?? [];
      return envVars.map((e) => e.name).filter(Boolean).sort();
    } catch {
      continue;
    }
  }
  throw new Error(`Service ${name} not found in any namespace`);
}

// ─── Cloud Run ───

interface GCPService {
  name: string;
  template?: {
    containers?: Array<{
      env?: Array<{ name: string }>;
    }>;
  };
}

async function getEnvNamesCloudRun(name: string): Promise<string[]> {
  const token = await getAccessToken();
  const svc = await gcpApi<GCPService>(
    `run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${name}`,
    token
  );
  const envVars = svc.template?.containers?.[0]?.env ?? [];
  return envVars.map((e) => e.name).filter(Boolean).sort();
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
    const names = isGKE()
      ? await getEnvNamesGKE(name)
      : await getEnvNamesCloudRun(name);

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
