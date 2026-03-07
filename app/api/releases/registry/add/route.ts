import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { SERVICE_REGISTRY } from "@/lib/releases/services";
import type {
  AppGroup,
  MigrationStrategy,
  ServiceLang,
  ServiceType,
} from "@/lib/releases/services";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AddServicePayload {
  name: string;
  displayName: string;
  appGroup: AppGroup;
  type: ServiceType;
  lang: ServiceLang;
  hasDb: boolean;
  migration: MigrationStrategy;
  usesGoShared: boolean;
  sidecar: "cloud-sql-proxy" | "none";
  publishesEvents: boolean;
  pubsubTopic: string;
  invokes: string[];
  secrets: string[];
  storageApps: string[];
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

const INFRA_REPO_OWNER = "tesserix";
const INFRA_REPO_NAME = "tesserix-infra";
const SERVICES_YAML_PATH = "services.yaml";
const BASE_BRANCH = "main";

function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? "";
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function ghFetch<T = unknown>(
  path: string,
  init?: RequestInit
): Promise<{ data: T; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...githubHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  return { data, status: res.status };
}

/** Get the SHA of the HEAD commit on the base branch. */
async function getBaseSha(): Promise<string> {
  const { data } = await ghFetch<{ object: { sha: string } }>(
    `/repos/${INFRA_REPO_OWNER}/${INFRA_REPO_NAME}/git/ref/heads/${BASE_BRANCH}`
  );
  return data.object.sha;
}

/** Get the current content + blob SHA of services.yaml. */
async function getServicesYaml(): Promise<{
  content: string;
  blobSha: string;
}> {
  const { data } = await ghFetch<{
    content: string;
    sha: string;
    encoding: string;
  }>(
    `/repos/${INFRA_REPO_OWNER}/${INFRA_REPO_NAME}/contents/${SERVICES_YAML_PATH}?ref=${BASE_BRANCH}`
  );
  const content = Buffer.from(data.content, "base64").toString("utf8");
  return { content, blobSha: data.sha };
}

/** Create a new branch from a given SHA. */
async function createBranch(branchName: string, sha: string): Promise<void> {
  await ghFetch(
    `/repos/${INFRA_REPO_OWNER}/${INFRA_REPO_NAME}/git/refs`,
    {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha }),
    }
  );
}

/** Commit updated services.yaml content to the branch. */
async function commitFile(
  branchName: string,
  newContent: string,
  blobSha: string,
  commitMessage: string
): Promise<void> {
  await ghFetch(
    `/repos/${INFRA_REPO_OWNER}/${INFRA_REPO_NAME}/contents/${SERVICES_YAML_PATH}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(newContent, "utf8").toString("base64"),
        sha: blobSha,
        branch: branchName,
      }),
    }
  );
}

/** Open a pull request and return the PR HTML URL. */
async function createPR(
  branchName: string,
  title: string,
  body: string
): Promise<string> {
  const { data } = await ghFetch<{ html_url: string }>(
    `/repos/${INFRA_REPO_OWNER}/${INFRA_REPO_NAME}/pulls`,
    {
      method: "POST",
      body: JSON.stringify({
        title,
        body,
        head: branchName,
        base: BASE_BRANCH,
      }),
    }
  );
  return data.html_url;
}

// ---------------------------------------------------------------------------
// YAML serialisation
// ---------------------------------------------------------------------------

function serializeValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function buildServiceYamlBlock(payload: AddServicePayload): string {
  const lines: string[] = [];

  const appendScalar = (key: string, value: string | boolean) => {
    lines.push(`  ${key}: ${value}`);
  };

  const appendList = (key: string, items: string[]) => {
    if (items.length === 0) {
      lines.push(`  ${key}: []`);
    } else {
      lines.push(`  ${key}:`);
      items.forEach((item) => lines.push(`    - ${item}`));
    }
  };

  lines.push(`- name: ${payload.name}`);
  appendScalar("displayName", payload.displayName);
  appendScalar("appGroup", payload.appGroup);
  appendScalar("type", payload.type);
  appendScalar("lang", payload.lang);
  appendScalar("repo", `tesserix/${payload.name}`);
  appendScalar("buildWorkflow", "ci.yml");
  appendScalar("releaseWorkflow", "release.yml");
  appendScalar("hasDb", payload.hasDb);
  appendScalar("migration", payload.migration);
  appendScalar("usesGoShared", payload.usesGoShared);
  appendScalar("sidecar", payload.sidecar);
  appendScalar("publishesEvents", payload.publishesEvents);
  appendScalar(
    "pubsubTopic",
    payload.publishesEvents && payload.pubsubTopic ? payload.pubsubTopic : '""'
  );
  appendList("invokes", payload.invokes);
  appendList("secrets", payload.secrets);
  appendList("storageApps", payload.storageApps);
  appendScalar("managed", true);

  return lines.join("\n");
}

function buildPRBody(payload: AddServicePayload): string {
  const lines: string[] = [
    `## New service: \`${payload.name}\``,
    "",
    `This PR was generated automatically by the Tesserix admin portal.`,
    "",
    "### Details",
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| Display name | ${payload.displayName} |`,
    `| App group | ${payload.appGroup} |`,
    `| Type | ${payload.type} |`,
    `| Language | ${payload.lang} |`,
    `| Has DB | ${payload.hasDb} |`,
    `| Migration | ${payload.migration} |`,
    `| go-shared | ${payload.usesGoShared} |`,
    `| Sidecar | ${payload.sidecar} |`,
    `| Publishes events | ${payload.publishesEvents} |`,
    ...(payload.publishesEvents && payload.pubsubTopic
      ? [`| Pub/Sub topic | \`${payload.pubsubTopic}\` |`]
      : []),
    ...(payload.invokes.length > 0
      ? [`| Invokes | ${payload.invokes.map((n) => `\`${n}\``).join(", ")} |`]
      : []),
    ...(payload.secrets.length > 0
      ? [`| Secrets | ${payload.secrets.map((s) => `\`${s}\``).join(", ")} |`]
      : []),
    ...(payload.storageApps.length > 0
      ? [`| Storage apps | ${payload.storageApps.join(", ")} |`]
      : []),
    "",
    "> Review the generated YAML block in `services.yaml` before merging.",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePayload(
  body: unknown
): { valid: true; payload: AddServicePayload } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Invalid request body" };
  }

  const b = body as Record<string, unknown>;

  if (!b.name || typeof b.name !== "string" || !/^[a-z0-9-]+$/.test(b.name)) {
    return {
      valid: false,
      error: "name is required and must be kebab-case (a-z, 0-9, hyphens)",
    };
  }
  if (!b.displayName || typeof b.displayName !== "string") {
    return { valid: false, error: "displayName is required" };
  }
  if (!["platform", "mark8ly"].includes(b.appGroup as string)) {
    return { valid: false, error: "appGroup must be platform or mark8ly" };
  }
  if (!["backend", "frontend"].includes(b.type as string)) {
    return { valid: false, error: "type must be backend or frontend" };
  }
  if (!["go", "nextjs"].includes(b.lang as string)) {
    return { valid: false, error: "lang must be go or nextjs" };
  }
  if (
    b.publishesEvents === true &&
    (!b.pubsubTopic || typeof b.pubsubTopic !== "string" || !(b.pubsubTopic as string).trim())
  ) {
    return {
      valid: false,
      error: "pubsubTopic is required when publishesEvents is true",
    };
  }

  const invokes = Array.isArray(b.invokes) ? (b.invokes as string[]) : [];
  const secrets = Array.isArray(b.secrets) ? (b.secrets as string[]) : [];
  const storageApps = Array.isArray(b.storageApps)
    ? (b.storageApps as string[])
    : [];

  return {
    valid: true,
    payload: {
      name: b.name as string,
      displayName: b.displayName as string,
      appGroup: b.appGroup as AppGroup,
      type: b.type as ServiceType,
      lang: b.lang as ServiceLang,
      hasDb: Boolean(b.hasDb),
      migration: (b.migration as MigrationStrategy) ?? "none",
      usesGoShared: Boolean(b.usesGoShared),
      sidecar: (b.sidecar as "cloud-sql-proxy" | "none") ?? "none",
      publishesEvents: Boolean(b.publishesEvents),
      pubsubTopic: typeof b.pubsubTopic === "string" ? b.pubsubTopic : "",
      invokes,
      secrets,
      storageApps,
    },
  };
}

// Silence unused import warning from TypeScript for serializeValue
void serializeValue;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rawBody = await request.json();
    const validation = validatePayload(rawBody);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const { payload } = validation;

    // Uniqueness check against current registry
    const exists = SERVICE_REGISTRY.some((s) => s.name === payload.name);
    if (exists) {
      return NextResponse.json(
        { error: `Service "${payload.name}" already exists in the registry` },
        { status: 409 }
      );
    }

    if (!process.env.GITHUB_TOKEN) {
      return NextResponse.json(
        { error: "GITHUB_TOKEN is not configured on the server" },
        { status: 500 }
      );
    }

    // Build the new YAML block
    const yamlBlock = buildServiceYamlBlock(payload);

    // Fetch base SHA and current file
    const [baseSha, { content: currentYaml, blobSha }] = await Promise.all([
      getBaseSha(),
      getServicesYaml(),
    ]);

    // Append the new block (with a blank line separator)
    const newYaml =
      currentYaml.trimEnd() + "\n\n" + yamlBlock + "\n";

    // Branch name: feat/add-<service-name>-<short-timestamp>
    const timestamp = Date.now().toString(36);
    const branchName = `feat/add-${payload.name}-${timestamp}`;

    // Create branch, commit, and open PR sequentially
    await createBranch(branchName, baseSha);

    await commitFile(
      branchName,
      newYaml,
      blobSha,
      `feat: add ${payload.name} to service registry`
    );

    const prTitle = `feat: add ${payload.name} to service registry`;
    const prBody = buildPRBody(payload);
    const prUrl = await createPR(branchName, prTitle, prBody);

    return NextResponse.json({ success: true, prUrl });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create service PR";
    console.error("[releases/registry/add]", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
