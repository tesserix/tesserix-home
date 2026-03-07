import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServiceByName } from "@/lib/releases/services";
import { getRepoTags } from "@/lib/releases/github";
import { isLocked } from "@/lib/releases/deploy-lock";
import { recordEvent } from "@/lib/releases/release-events";

const GCP_PROJECT = process.env.GCP_PROJECT_ID || "tesserix";
const GCP_REGION = process.env.GCP_REGION || "asia-south1";
const GAR_URL = `${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/services`;

/** GET — List available versions for rollback */
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const serviceName = request.nextUrl.searchParams.get("service");
    if (!serviceName) {
      return NextResponse.json(
        { error: "service query param is required" },
        { status: 400 }
      );
    }

    const service = getServiceByName(serviceName);
    if (!service) {
      return NextResponse.json(
        { error: `Unknown service: ${serviceName}` },
        { status: 404 }
      );
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
    const message =
      err instanceof Error ? err.message : "Failed to fetch versions";
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
      return NextResponse.json(
        { error: `Unknown service: ${serviceName}` },
        { status: 404 }
      );
    }

    if (isLocked(serviceName)) {
      return NextResponse.json(
        { error: `Service ${serviceName} is locked for deployments` },
        { status: 423 }
      );
    }

    // Get access token from metadata server
    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }
    );

    if (!tokenRes.ok) {
      return NextResponse.json(
        { error: "Failed to get GCP access token (not running on Cloud Run?)" },
        { status: 503 }
      );
    }

    const { access_token } = await tokenRes.json();

    // Get current service config
    const getRes = await fetch(
      `https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${service.name}`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    if (!getRes.ok) {
      const body = await getRes.text();
      return NextResponse.json(
        { error: `Cloud Run API error: ${body.slice(0, 200)}` },
        { status: getRes.status }
      );
    }

    const svcData = await getRes.json();

    // Update the app container image to the rollback version
    const targetImage = `${GAR_URL}/${service.name}:v${version}`;
    const containers = svcData.template?.containers ?? [];
    const appContainer = containers.find(
      (c: any) => c.name === service.name || !c.name?.includes("cloud-sql-proxy")
    );

    if (appContainer) {
      appContainer.image = targetImage;
    }

    // Add rollback annotation
    if (!svcData.template.annotations) svcData.template.annotations = {};
    svcData.template.annotations["tesserix.app/rolledBackAt"] =
      new Date().toISOString();
    svcData.template.annotations["tesserix.app/rolledBackTo"] = `v${version}`;

    const updateRes = await fetch(
      `https://run.googleapis.com/v2/projects/${GCP_PROJECT}/locations/${GCP_REGION}/services/${service.name}`,
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
      return NextResponse.json(
        { error: `Rollback failed: ${body.slice(0, 200)}` },
        { status: updateRes.status }
      );
    }

    recordEvent("rollback", service.name, service.displayName, {
      toVersion: version,
    });

    return NextResponse.json({
      success: true,
      serviceName: service.name,
      version,
      image: targetImage,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to rollback service";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
