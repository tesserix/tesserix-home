import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { REPOS_WITH_WORKFLOWS } from "@/lib/releases/services";
import { getWorkflowRun } from "@/lib/releases/github";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { runId } = await params;
    const repoParam = request.nextUrl.searchParams.get("repo");
    if (!repoParam) {
      return NextResponse.json(
        { error: "repo query parameter is required" },
        { status: 400 }
      );
    }

    const fullRepo = REPOS_WITH_WORKFLOWS.find((r) =>
      r.endsWith(`/${repoParam}`)
    );
    if (!fullRepo) {
      return NextResponse.json(
        { error: `Unknown repo: ${repoParam}` },
        { status: 404 }
      );
    }

    const run = await getWorkflowRun(fullRepo, Number(runId));
    return NextResponse.json(run);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch workflow run";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
