import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  SERVICE_REGISTRY,
  REPOS_WITH_WORKFLOWS,
  parseRepo,
  type ServiceType,
} from "@/lib/releases/services";
import {
  getWorkflowRuns,
  getRepoTags,
  type WorkflowRun,
  type GitTag,
} from "@/lib/releases/github";

function workflowFileName(path: string): string {
  return path.split("/").pop() ?? path;
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

/** Find the latest semver tag (per-repo: plain "v1.2.3" tags). */
function findLatestTag(tags: GitTag[]): { version: string; sha: string } | null {
  for (const tag of tags) {
    if (tag.name.match(/^v\d+\.\d+\.\d+$/)) {
      return { version: tag.name.slice(1), sha: tag.commit.sha };
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const url = request.nextUrl;
    const typeFilter = url.searchParams.get("type") as ServiceType | null;
    const searchFilter = url.searchParams.get("search")?.toLowerCase();

    // Fetch runs + tags per-repo in parallel
    const repoData = await Promise.allSettled(
      REPOS_WITH_WORKFLOWS.map(async (fullRepo) => {
        const [runs, tags] = await Promise.all([
          getWorkflowRuns(fullRepo, { per_page: 20 }),
          getRepoTags(fullRepo),
        ]);
        return { fullRepo, runs, tags };
      })
    );

    // Index by repo
    const runsMap = new Map<string, WorkflowRun[]>();
    const tagsMap = new Map<string, GitTag[]>();
    for (const result of repoData) {
      if (result.status === "fulfilled") {
        runsMap.set(result.value.fullRepo, result.value.runs);
        tagsMap.set(result.value.fullRepo, result.value.tags);
      }
    }

    // Build service info
    let services = SERVICE_REGISTRY.map((svc) => {
      const runs = runsMap.get(svc.repo) ?? [];
      const tags = tagsMap.get(svc.repo) ?? [];

      // Find latest CI build run
      const buildRun = runs.find(
        (r) => workflowFileName(r.path) === svc.buildWorkflow
      );
      const latestBuild = buildRun
        ? {
            tag: buildRun.head_branch,
            status: mapStatus(buildRun),
            conclusion: buildRun.conclusion,
            runUrl: buildRun.html_url,
            createdAt: buildRun.created_at,
          }
        : null;

      // Find latest release run
      const releaseRun = runs.find(
        (r) => workflowFileName(r.path) === svc.releaseWorkflow
      );
      const tagInfo = findLatestTag(tags);
      const latestRelease =
        releaseRun || tagInfo
          ? {
              version: tagInfo?.version ?? "-",
              status: releaseRun ? mapStatus(releaseRun) : ("none" as const),
              conclusion: releaseRun?.conclusion ?? null,
              runUrl: releaseRun?.html_url ?? "",
              createdAt: releaseRun?.created_at ?? "",
            }
          : null;

      return {
        name: svc.name,
        displayName: svc.displayName,
        type: svc.type,
        repo: svc.repo,
        appGroup: svc.appGroup,
        latestBuild,
        latestRelease,
      };
    });

    // Apply filters
    if (typeFilter) {
      services = services.filter((s) => s.type === typeFilter);
    }
    if (searchFilter) {
      services = services.filter(
        (s) =>
          s.name.toLowerCase().includes(searchFilter) ||
          s.displayName.toLowerCase().includes(searchFilter)
      );
    }

    return NextResponse.json({
      data: services,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch services";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
