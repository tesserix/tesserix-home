import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServiceByName } from "@/lib/releases/services";
import { rolloutRestart } from "@/lib/releases/k8s";

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

    await rolloutRestart(service.namespace, service.name);

    return NextResponse.json({
      success: true,
      serviceName: service.name,
      namespace: service.namespace,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to rollout restart";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
