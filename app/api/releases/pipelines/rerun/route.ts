import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { REPOS_WITH_WORKFLOWS } from "@/lib/releases/services";
import { rerunWorkflow } from "@/lib/releases/github";

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { runId, repo } = (await request.json()) as {
      runId: number;
      repo: string;
    };

    if (!runId || !repo) {
      return NextResponse.json(
        { error: "runId and repo are required" },
        { status: 400 }
      );
    }

    const fullRepo = REPOS_WITH_WORKFLOWS.find((r) =>
      r.endsWith(`/${repo}`)
    );
    if (!fullRepo) {
      return NextResponse.json(
        { error: `Unknown repo: ${repo}` },
        { status: 404 }
      );
    }

    await rerunWorkflow(fullRepo, runId);

    return NextResponse.json({ success: true, runId, repo });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to re-run workflow";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
