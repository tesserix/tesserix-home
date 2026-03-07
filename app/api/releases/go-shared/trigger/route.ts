import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { dispatchWorkflow } from "@/lib/releases/github";

const GO_SHARED_REPO = "tesserix/go-shared";
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { version } = (await request.json()) as { version: string };

    if (!version) {
      return NextResponse.json(
        { error: "version is required" },
        { status: 400 }
      );
    }

    if (!SEMVER_RE.test(version)) {
      return NextResponse.json(
        { error: "version must be in semver format (e.g. 1.2.3)" },
        { status: 400 }
      );
    }

    await dispatchWorkflow(GO_SHARED_REPO, "release.yml", `v${version}`);

    return NextResponse.json({
      success: true,
      version,
      repo: GO_SHARED_REPO,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to trigger go-shared release";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
