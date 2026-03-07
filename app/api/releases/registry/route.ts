import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  SERVICE_REGISTRY,
  getServiceDependents,
  type ServiceConfig,
} from "@/lib/releases/services";

export interface RegistryServiceResponse extends ServiceConfig {
  dependents: string[];
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const data: RegistryServiceResponse[] = SERVICE_REGISTRY.map((svc) => ({
      ...svc,
      dependents: getServiceDependents(svc.name).map((s) => s.name),
    }));

    return NextResponse.json({
      data,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch registry";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
