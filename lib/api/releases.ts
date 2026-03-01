"use client";

import { useApi, apiFetch } from "./use-api";
import type { ServiceType, AppGroup } from "@/lib/releases/services";

// ---------- Response types ----------

export type BuildStatus =
  | "success"
  | "failure"
  | "in_progress"
  | "queued"
  | "cancelled"
  | "none";

export interface ServiceBuild {
  tag: string;
  status: BuildStatus;
  conclusion: string | null;
  runUrl: string;
  createdAt: string;
}

export interface ServiceRelease {
  version: string;
  status: BuildStatus;
  conclusion: string | null;
  runUrl: string;
  createdAt: string;
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  type: ServiceType;
  repo: string;
  latestBuild: ServiceBuild | null;
  latestRelease: ServiceRelease | null;
}

export interface ServicesResponse {
  data: ServiceInfo[];
  lastUpdated: string;
}

export interface PipelineRun {
  id: number;
  serviceName: string;
  workflowType: "build" | "release" | "other";
  workflowName: string;
  branch: string;
  status: BuildStatus;
  conclusion: string | null;
  duration: number | null; // seconds
  createdAt: string;
  commitSha: string;
  commitUrl: string;
  runUrl: string;
  event: string;
  displayTitle: string;
}

export interface PipelinesResponse {
  data: PipelineRun[];
  lastUpdated: string;
}

export interface PromoteResponse {
  success: boolean;
  version: string;
  repo: string;
  serviceName: string;
}

// ---------- Hooks ----------

export function useServices(params?: { type?: ServiceType; search?: string }) {
  const searchParams = new URLSearchParams();
  if (params?.type) searchParams.set("type", params.type);
  if (params?.search) searchParams.set("search", params.search);
  const qs = searchParams.toString();
  return useApi<ServicesResponse>(
    `/api/releases/services${qs ? `?${qs}` : ""}`
  );
}

export function usePipelines(params?: {
  status?: string;
  repo?: string;
  page?: number;
  limit?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set("status", params.status);
  if (params?.repo) searchParams.set("repo", params.repo);
  if (params?.page) searchParams.set("page", String(params.page));
  if (params?.limit) searchParams.set("limit", String(params.limit));
  const qs = searchParams.toString();
  return useApi<PipelinesResponse>(
    `/api/releases/pipelines${qs ? `?${qs}` : ""}`
  );
}

export async function promoteService(
  serviceName: string,
  version: string
): Promise<{ data?: PromoteResponse; error?: string }> {
  return apiFetch<PromoteResponse>("/api/releases/promote", {
    method: "POST",
    body: JSON.stringify({ serviceName, version }),
  });
}

export async function promoteGroup(
  appGroup: AppGroup,
  version: string
): Promise<{
  data?: { success: boolean; succeeded: string[]; failed: string[] };
  error?: string;
}> {
  return apiFetch("/api/releases/promote-group", {
    method: "POST",
    body: JSON.stringify({ appGroup, version }),
  });
}

export async function rerunPipeline(
  runId: number,
  repo: string
): Promise<{ data?: { success: boolean }; error?: string }> {
  return apiFetch("/api/releases/pipelines/rerun", {
    method: "POST",
    body: JSON.stringify({ runId, repo }),
  });
}

export async function syncService(
  serviceName: string
): Promise<{ data?: { success: boolean }; error?: string }> {
  return apiFetch("/api/releases/sync", {
    method: "POST",
    body: JSON.stringify({ serviceName }),
  });
}

export async function rolloutService(
  serviceName: string
): Promise<{ data?: { success: boolean }; error?: string }> {
  return apiFetch("/api/releases/rollout", {
    method: "POST",
    body: JSON.stringify({ serviceName }),
  });
}
