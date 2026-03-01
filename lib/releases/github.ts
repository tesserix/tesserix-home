import { parseRepo } from "./services";

// ---------- Types ----------

export interface WorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  status: "completed" | "in_progress" | "queued" | "requested" | "waiting";
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  path: string; // e.g. ".github/workflows/settings-service-build.yml"
  event: string;
  display_title: string;
}

export interface GitTag {
  name: string;
  commit: { sha: string; url: string };
}

// ---------- Cache ----------

const cache = new Map<string, { data: unknown; expiresAt: number }>();
const CACHE_TTL = 30_000; // 30 seconds

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

// ---------- HTTP helpers ----------

function getToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  return token;
}

async function ghFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${getToken()}`,
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

// ---------- API functions ----------

export async function getWorkflowRuns(
  fullRepo: string,
  opts?: { per_page?: number; status?: string }
): Promise<WorkflowRun[]> {
  const { owner, repo } = parseRepo(fullRepo);
  const params = new URLSearchParams({
    per_page: String(opts?.per_page ?? 100),
  });
  if (opts?.status) params.set("status", opts.status);

  const cacheKey = `runs:${fullRepo}:${params}`;
  const cached = getCached<{ workflow_runs: WorkflowRun[] }>(cacheKey);
  if (cached) return cached.workflow_runs;

  const data = await ghFetch<{ workflow_runs: WorkflowRun[] }>(
    `/repos/${owner}/${repo}/actions/runs?${params}`
  );
  setCache(cacheKey, data);
  return data.workflow_runs;
}

export async function getWorkflowRun(
  fullRepo: string,
  runId: number
): Promise<WorkflowRun> {
  const { owner, repo } = parseRepo(fullRepo);
  return ghFetch<WorkflowRun>(`/repos/${owner}/${repo}/actions/runs/${runId}`);
}

export async function getRepoTags(
  fullRepo: string,
  opts?: { per_page?: number }
): Promise<GitTag[]> {
  const { owner, repo } = parseRepo(fullRepo);
  const params = new URLSearchParams({
    per_page: String(opts?.per_page ?? 100),
  });

  const cacheKey = `tags:${fullRepo}:${params}`;
  const cached = getCached<GitTag[]>(cacheKey);
  if (cached) return cached;

  const data = await ghFetch<GitTag[]>(
    `/repos/${owner}/${repo}/tags?${params}`
  );
  setCache(cacheKey, data);
  return data;
}

export async function dispatchWorkflow(
  fullRepo: string,
  workflowFile: string,
  tag: string
): Promise<void> {
  const { owner, repo } = parseRepo(fullRepo);
  await ghFetch(`/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { tag } }),
  });
}

export async function rerunWorkflow(
  fullRepo: string,
  runId: number
): Promise<void> {
  const { owner, repo } = parseRepo(fullRepo);
  await ghFetch(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, {
    method: "POST",
  });
}
