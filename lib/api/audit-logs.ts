"use client";

import { useApi, apiFetch } from './use-api';

export type AuditSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface AuditLog {
  id: string;
  timestamp: string;
  actor: string;
  actor_type: string;
  action: string;
  resource_type: string;
  resource_id: string;
  severity: AuditSeverity;
  ip_address?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
  changes?: Record<string, unknown>;
  tenant_id?: string;
}

export interface AuditLogSummary {
  total_events: number;
  critical_events: number;
  failed_auth_attempts: number;
  events_today: number;
  events_by_severity: Record<AuditSeverity, number>;
  events_by_action: Record<string, number>;
}

export interface RetentionSettings {
  retention_days: number;
  auto_cleanup_enabled: boolean;
  last_cleanup_at?: string;
  next_cleanup_at?: string;
}

export interface ComplianceReport {
  generated_at: string;
  period_start: string;
  period_end: string;
  total_events: number;
  data_access_events: number;
  admin_actions: number;
  security_events: number;
  compliance_score: number;
  findings: ComplianceFinding[];
}

export interface ComplianceFinding {
  severity: AuditSeverity;
  category: string;
  description: string;
  recommendation: string;
}

export interface AuditLogFilters {
  search?: string;
  severity?: AuditSeverity;
  action?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

// Hooks

export function useAuditLogs(filters: AuditLogFilters = {}) {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.action) params.set('action', filters.action);
  if (filters.startDate) params.set('start_date', filters.startDate);
  if (filters.endDate) params.set('end_date', filters.endDate);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return useApi<AuditLog[]>(`/api/audit-logs${qs ? `?${qs}` : ''}`);
}

export function useAuditLog(id: string | null) {
  return useApi<AuditLog>(id ? `/api/audit-logs/${id}` : null);
}

export function useAuditLogSummary() {
  return useApi<AuditLogSummary>('/api/audit-logs/summary');
}

export function useRetentionSettings() {
  return useApi<RetentionSettings>('/api/audit-logs/retention');
}

export function useComplianceReport() {
  return useApi<ComplianceReport>('/api/audit-logs/compliance');
}

// Mutations

export async function updateRetentionSettings(settings: Partial<RetentionSettings>) {
  return apiFetch<RetentionSettings>('/api/audit-logs/retention', {
    method: 'PUT',
    body: JSON.stringify(settings),
  });
}

export async function triggerCleanup() {
  return apiFetch('/api/audit-logs/cleanup', {
    method: 'POST',
  });
}
