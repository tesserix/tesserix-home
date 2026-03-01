import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServiceByName } from "@/lib/releases/services";
import { dispatchWorkflow } from "@/lib/releases/github";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { serviceName, version } = body as {
      serviceName: string;
      version: string;
    };

    if (!serviceName || !version) {
      return NextResponse.json(
        { error: "serviceName and version are required" },
        { status: 400 }
      );
    }

    if (!SEMVER_RE.test(version)) {
      return NextResponse.json(
        { error: "version must be in semver format (e.g. 1.2.3)" },
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

    if (!service.repo || !service.releaseWorkflow) {
      return NextResponse.json(
        { error: `Service ${serviceName} does not support promotion` },
        { status: 400 }
      );
    }

    await dispatchWorkflow(service.repo, service.releaseWorkflow, `v${version}`);

    return NextResponse.json({
      success: true,
      version,
      repo: service.repo,
      serviceName: service.name,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to trigger release";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
