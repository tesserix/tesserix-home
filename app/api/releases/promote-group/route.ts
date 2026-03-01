import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServicesByAppGroup, type AppGroup } from "@/lib/releases/services";
import { dispatchWorkflow } from "@/lib/releases/github";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appGroup, version } = (await request.json()) as {
      appGroup: AppGroup;
      version: string;
    };

    if (!appGroup || !version) {
      return NextResponse.json(
        { error: "appGroup and version are required" },
        { status: 400 }
      );
    }

    if (!SEMVER_RE.test(version)) {
      return NextResponse.json(
        { error: "version must be in semver format (e.g. 1.2.3)" },
        { status: 400 }
      );
    }

    const services = getServicesByAppGroup(appGroup);
    if (services.length === 0) {
      return NextResponse.json(
        { error: `No services in group: ${appGroup}` },
        { status: 404 }
      );
    }

    const tag = `v${version}`;
    const results = await Promise.allSettled(
      services.map(async (svc) => {
        await dispatchWorkflow(svc.repo, svc.releaseWorkflow, tag);
        return svc.name;
      })
    );

    const succeeded = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<string>).value);
    const failed = results
      .filter((r) => r.status === "rejected")
      .map((_, i) => services[i].name);

    return NextResponse.json({
      success: failed.length === 0,
      version,
      appGroup,
      succeeded,
      failed,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to trigger group release";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
