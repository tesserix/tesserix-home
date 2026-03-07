import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServiceByName } from "@/lib/releases/services";

const GCP_PROJECT = process.env.GCP_PROJECT_ID || "tesserix";
const GCP_REGION = process.env.GCP_REGION || "asia-south1";

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { serviceName } = (await request.json()) as { serviceName: string };
    if (!serviceName) {
      return NextResponse.json(
        { error: "serviceName is required" },
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

    // Get access token from metadata server (Cloud Run SA)
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

    // Get the current service to find the latest revision
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

    // Force a new revision by updating an annotation
    const annotations = svcData.template?.metadata?.annotations || {};
    annotations["client.knative.dev/restartedAt"] = new Date().toISOString();

    if (!svcData.template) svcData.template = {};
    if (!svcData.template.metadata) svcData.template.metadata = {};
    svcData.template.metadata.annotations = annotations;

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
        { error: `Restart failed: ${body.slice(0, 200)}` },
        { status: updateRes.status }
      );
    }

    return NextResponse.json({
      success: true,
      serviceName: service.name,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to restart service";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
