import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getServiceByName } from "@/lib/releases/services";
import {
  getAllLocks,
  getLock,
  setLock,
  removeLock,
} from "@/lib/releases/deploy-lock";
import { recordEvent } from "@/lib/releases/release-events";

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({
      data: getAllLocks(),
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch locks";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { serviceName, reason } = (await request.json()) as {
      serviceName: string;
      reason?: string;
    };

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

    const existing = getLock(serviceName);
    if (existing) {
      return NextResponse.json(
        { error: `Service already locked by ${existing.lockedBy}` },
        { status: 409 }
      );
    }

    // TODO: Extract actual user from session
    const lock = setLock(serviceName, "admin", reason ?? "");

    recordEvent("lock", serviceName, service.displayName, {
      triggeredBy: "admin",
    });

    return NextResponse.json({ success: true, lock });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to lock service";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { serviceName } = (await request.json()) as {
      serviceName: string;
    };

    if (!serviceName) {
      return NextResponse.json(
        { error: "serviceName is required" },
        { status: 400 }
      );
    }

    const existed = removeLock(serviceName);

    if (existed) {
      const service = getServiceByName(serviceName);
      recordEvent("unlock", serviceName, service?.displayName ?? serviceName, {
        triggeredBy: "admin",
      });
    }

    return NextResponse.json({ success: true, removed: existed });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to unlock service";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
