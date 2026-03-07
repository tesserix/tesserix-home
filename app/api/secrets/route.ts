import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { REPOS_WITH_WORKFLOWS } from "@/lib/releases/services";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

async function ghFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

interface GHSecret {
  name: string;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/secrets — List secrets for all repos
 * GET /api/secrets?repo=auth-bff — List secrets for specific repo
 */
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const repoFilter = request.nextUrl.searchParams.get("repo");

    const repos = repoFilter
      ? REPOS_WITH_WORKFLOWS.filter((r) => r.endsWith(`/${repoFilter}`))
      : REPOS_WITH_WORKFLOWS;

    const results = await Promise.allSettled(
      repos.map(async (fullRepo) => {
        const [owner, repo] = fullRepo.split("/");
        const data = await ghFetch<{ secrets: GHSecret[] }>(
          `/repos/${owner}/${repo}/actions/secrets`
        );
        return {
          repo: fullRepo,
          repoShort: repo,
          secrets: data.secrets.map((s) => ({
            name: s.name,
            createdAt: s.created_at,
            updatedAt: s.updated_at,
          })),
        };
      })
    );

    const data = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => (r as PromiseFulfilledResult<any>).value);

    return NextResponse.json({ data });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch secrets";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
