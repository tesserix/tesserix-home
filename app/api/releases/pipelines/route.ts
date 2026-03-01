import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  SERVICE_REGISTRY,
  REPOS_WITH_WORKFLOWS,
  parseRepo,
} from "@/lib/releases/services";
import { getWorkflowRuns, type WorkflowRun } from "@/lib/releases/github";

function workflowFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function resolveServiceName(run: WorkflowRun): string {
  const filename = workflowFileName(run.path);
  const svc = SERVICE_REGISTRY.find(
    (s) => s.buildWorkflow === filename || s.releaseWorkflow === filename
  );
  return svc?.displayName ?? filename.replace(/-build\.yml$|-release\.yml$/, "");
}

function resolveWorkflowType(run: WorkflowRun): "build" | "release" | "other" {
  const filename = workflowFileName(run.path);
  if (filename.endsWith("-build.yml")) return "build";
  if (filename.endsWith("-release.yml")) return "release";
  return "other";
}

function mapStatus(
  run: WorkflowRun
): "success" | "failure" | "in_progress" | "queued" | "cancelled" {
  if (run.status === "completed") {
    if (run.conclusion === "success") return "success";
    if (run.conclusion === "cancelled") return "cancelled";
    return "failure";
  }
  if (run.status === "in_progress") return "in_progress";
  return "queued";
}

function durationSeconds(run: WorkflowRun): number | null {
  if (run.status !== "completed") return null;
  const start = new Date(run.run_started_at || run.created_at).getTime();
  const end = new Date(run.updated_at).getTime();
  return Math.round((end - start) / 1000);
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = request.nextUrl;
    const statusFilter = url.searchParams.get("status");
    const repoFilter = url.searchParams.get("repo");
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));

    // Determine which repos to fetch
    const repos = repoFilter
      ? REPOS_WITH_WORKFLOWS.filter((r) => r.endsWith(`/${repoFilter}`))
      : REPOS_WITH_WORKFLOWS;

    // Fetch runs from all repos in parallel
    const results = await Promise.allSettled(
      repos.map((fullRepo) =>
        getWorkflowRuns(fullRepo, {
          per_page: 50,
          ...(statusFilter === "in_progress" ? { status: "in_progress" } : {}),
        })
      )
    );

    // Merge and sort
    let allRuns: { run: WorkflowRun; fullRepo: string }[] = [];
    repos.forEach((fullRepo, i) => {
      const result = results[i];
      if (result.status === "fulfilled") {
        for (const run of result.value) {
          allRuns.push({ run, fullRepo });
        }
      }
    });

    allRuns.sort(
      (a, b) =>
        new Date(b.run.created_at).getTime() -
        new Date(a.run.created_at).getTime()
    );

    // Filter by status after merge
    if (statusFilter && statusFilter !== "in_progress") {
      allRuns = allRuns.filter((item) => {
        const s = mapStatus(item.run);
        if (statusFilter === "completed") return s === "success" || s === "failure" || s === "cancelled";
        return s === statusFilter;
      });
    }

    // Paginate
    const start = (page - 1) * limit;
    const pageRuns = allRuns.slice(start, start + limit);

    const { owner: ghOwner } = parseRepo(repos[0] ?? "Tesseract-Nexus/global-services");
    const data = pageRuns.map(({ run, fullRepo }) => {
      const { repo } = parseRepo(fullRepo);
      return {
        id: run.id,
        serviceName: resolveServiceName(run),
        workflowType: resolveWorkflowType(run),
        workflowName: run.name,
        branch: run.head_branch,
        status: mapStatus(run),
        conclusion: run.conclusion,
        duration: durationSeconds(run),
        createdAt: run.created_at,
        commitSha: run.head_sha.slice(0, 7),
        commitUrl: `https://github.com/${fullRepo}/commit/${run.head_sha}`,
        runUrl: run.html_url,
        event: run.event,
        displayTitle: run.display_title,
      };
    });

    return NextResponse.json({
      data,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch pipelines";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
