"use client";

import { useApi } from './use-api';

// --- Backend response types (match Go status-service) ---

export type OverallStatus = 'operational' | 'degraded' | 'outage';
export type ServiceHealth = 'healthy' | 'unhealthy' | 'degraded' | 'unknown';

export interface ServiceSummary {
  id: string;
  name: string;
  displayName: string;
  category: string;
  status: ServiceHealth;
  uptime30d: number;
  slaTarget: number;
  slaMet: boolean;
  responseTimeMs: number;
  lastCheckAt: string;
}

export interface Incident {
  id: string;
  serviceId: string;
  serviceName: string;
  title: string;
  status: 'investigating' | 'monitoring' | 'resolved';
  startedAt: string;
  resolvedAt?: string;
}

export interface OverallStats {
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  unhealthyServices: number;
  unknownServices: number;
  overallUptime: number;
  avgResponseMs: number;
  lastUpdated: string;
}

export interface StatusResponse {
  status: OverallStatus;
  services: ServiceSummary[];
  incidents: Incident[];
  stats: OverallStats;
  lastUpdated: string;
}

// --- App grouping ---
// Groups match the categories defined in status-service/internal/config/config.go

export type AppGroup = 'Core' | 'Application' | 'Communication' | 'Supporting';

export function getAppGroup(category: string): AppGroup {
  switch (category) {
    case 'Core': return 'Core';
    case 'Application': return 'Application';
    case 'Communication': return 'Communication';
    case 'Supporting': return 'Supporting';
    default: return 'Supporting';
  }
}

export function groupServicesByApp(services: ServiceSummary[]): Record<AppGroup, ServiceSummary[]> {
  const groups: Record<AppGroup, ServiceSummary[]> = {
    Core: [],
    Application: [],
    Communication: [],
    Supporting: [],
  };

  for (const svc of services) {
    const app = getAppGroup(svc.category);
    groups[app].push(svc);
  }

  return groups;
}

// --- Hook ---

export function useSystemHealth() {
  return useApi<StatusResponse>('/api/system-health');
}
