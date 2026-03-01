import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServiceByName } from "@/lib/releases/services";
import { syncApp } from "@/lib/releases/argocd";

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

    await syncApp(service.argoApp);

    return NextResponse.json({
      success: true,
      serviceName: service.name,
      argoApp: service.argoApp,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to sync ArgoCD app";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
