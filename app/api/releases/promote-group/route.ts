import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServicesByAppGroup, type AppGroup } from "@/lib/releases/services";
import { dispatchWorkflow } from "@/lib/releases/github";
import { isLocked, getLock } from "@/lib/releases/deploy-lock";
import { recordEvent } from "@/lib/releases/release-events";

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

    // Check for locked services
    const lockedServices = services.filter((s) => isLocked(s.name));
    if (lockedServices.length > 0) {
      const lockedNames = lockedServices.map((s) => {
        const lock = getLock(s.name)!;
        return `${s.name} (by ${lock.lockedBy})`;
      });
      return NextResponse.json(
        { error: `Locked services: ${lockedNames.join(", ")}` },
        { status: 423 }
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

    for (const name of succeeded) {
      const svc = services.find((s) => s.name === name);
      recordEvent("promote", name, svc?.displayName ?? name, {
        toVersion: version,
        pipelineUrl: svc ? `https://github.com/${svc.repo}/actions` : undefined,
      });
    }

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
