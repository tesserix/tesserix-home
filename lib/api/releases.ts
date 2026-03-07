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
  appGroup: AppGroup;
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

// ---------- go-shared types ----------

export type GoSharedConsumerStatus = "updated" | "pending" | "failed";

export interface GoSharedConsumer {
  name: string;
  displayName: string;
  currentVersion: string | null;
  status: GoSharedConsumerStatus;
  prUrl?: string;
}

export interface GoSharedResponse {
  currentVersion: string | null;
  previousVersion: string | null;
  releasedAt: string | null;
  consumers: GoSharedConsumer[];
  lastUpdated: string;
}

// ---------- Deploy lock types ----------

export interface DeployLock {
  serviceName: string;
  lockedBy: string;
  lockedAt: string;
  reason: string;
}

export interface LocksResponse {
  data: DeployLock[];
  lastUpdated: string;
}

// ---------- Rollback types ----------

export interface RollbackVersion {
  version: string;
  tag: string;
  sha: string;
}

export interface RollbackVersionsResponse {
  data: RollbackVersion[];
}

// ---------- Health types ----------

export type HealthStatus = "healthy" | "degraded" | "unknown";

export interface ServiceHealth {
  name: string;
  displayName: string;
  status: HealthStatus;
  instanceCount: number;
  maxInstances: number;
  latestRevision: string;
  latestImage: string;
  url: string;
  lastDeployedAt: string | null;
}

export interface HealthResponse {
  data: ServiceHealth[];
  available: boolean;
  lastUpdated: string;
}

// ---------- Release history types ----------

export type ReleaseAction = "promote" | "rollback" | "lock" | "unlock";

export interface ReleaseEvent {
  id: string;
  action: ReleaseAction;
  serviceName: string;
  serviceDisplayName: string;
  fromVersion?: string;
  toVersion?: string;
  triggeredBy: string;
  timestamp: string;
  pipelineUrl?: string;
}

export interface HistoryResponse {
  data: ReleaseEvent[];
  lastUpdated: string;
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

// ---------- go-shared ----------

export function useGoShared() {
  return useApi<GoSharedResponse>("/api/releases/go-shared");
}

export async function triggerGoSharedRelease(
  version: string
): Promise<{ data?: { success: boolean; version: string }; error?: string }> {
  return apiFetch("/api/releases/go-shared/trigger", {
    method: "POST",
    body: JSON.stringify({ version }),
  });
}

// ---------- Deploy Locks ----------

export function useDeployLocks() {
  return useApi<LocksResponse>("/api/releases/locks");
}

export async function lockService(
  serviceName: string,
  reason: string
): Promise<{ data?: { success: boolean; lock: DeployLock }; error?: string }> {
  return apiFetch("/api/releases/locks", {
    method: "POST",
    body: JSON.stringify({ serviceName, reason }),
  });
}

export async function unlockService(
  serviceName: string
): Promise<{ data?: { success: boolean }; error?: string }> {
  return apiFetch("/api/releases/locks", {
    method: "DELETE",
    body: JSON.stringify({ serviceName }),
  });
}

// ---------- Rollback ----------

export function useRollbackVersions(serviceName: string | null) {
  return useApi<RollbackVersionsResponse>(
    serviceName ? `/api/releases/rollback?service=${serviceName}` : null
  );
}

export async function rollbackService(
  serviceName: string,
  version: string
): Promise<{ data?: { success: boolean; version: string }; error?: string }> {
  return apiFetch("/api/releases/rollback", {
    method: "POST",
    body: JSON.stringify({ serviceName, version }),
  });
}

// ---------- Health ----------

export function useServiceHealth() {
  return useApi<HealthResponse>("/api/releases/health");
}

// ---------- History ----------

export function useReleaseHistory() {
  return useApi<HistoryResponse>("/api/releases/history");
}
