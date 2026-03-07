import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getGoSharedConsumers } from "@/lib/releases/services";
import { getRepoTags, type GitTag } from "@/lib/releases/github";

const GO_SHARED_REPO = "tesserix/go-shared";

function findSemverTags(tags: GitTag[], count: number): { version: string; sha: string }[] {
  const results: { version: string; sha: string }[] = [];
  for (const tag of tags) {
    if (tag.name.match(/^v\d+\.\d+\.\d+$/)) {
      results.push({ version: tag.name.slice(1), sha: tag.commit.sha });
      if (results.length >= count) break;
    }
  }
  return results;
}

async function getGoModVersion(fullRepo: string): Promise<string | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${fullRepo}/contents/go.mod`,
      {
        headers: {
          Accept: "application/vnd.github.raw+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!res.ok) return null;

    const content = await res.text();
    const match = content.match(
      /github\.com\/tesserix\/go-shared\s+(v\d+\.\d+\.\d+)/
    );
    return match ? match[1].slice(1) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Fetch go-shared tags
    const tags = await getRepoTags(GO_SHARED_REPO);
    const semverTags = findSemverTags(tags, 5);

    if (semverTags.length === 0) {
      return NextResponse.json({
        currentVersion: null,
        previousVersion: null,
        releasedAt: null,
        consumers: [],
        lastUpdated: new Date().toISOString(),
      });
    }

    const currentVersion = semverTags[0].version;
    const previousVersion = semverTags[1]?.version ?? null;

    // Fetch go.mod from all consumer repos in parallel
    const consumers = getGoSharedConsumers();
    const versionResults = await Promise.allSettled(
      consumers.map(async (svc) => {
        const version = await getGoModVersion(svc.repo);
        return {
          name: svc.name,
          displayName: svc.displayName,
          currentVersion: version,
          status:
            version === currentVersion
              ? ("updated" as const)
              : version
                ? ("pending" as const)
                : ("failed" as const),
        };
      })
    );

    const consumerStatuses = versionResults.map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      return {
        name: consumers[i].name,
        displayName: consumers[i].displayName,
        currentVersion: null,
        status: "failed" as const,
      };
    });

    return NextResponse.json({
      currentVersion,
      previousVersion,
      releasedAt: null, // Would need GitHub release API for exact date
      consumers: consumerStatuses,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch go-shared status";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
