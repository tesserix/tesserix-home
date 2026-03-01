"use client";

import { useApi } from './use-api';

// --- Backend response types (match Go status-dashboard-service) ---

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

export type AppGroup = 'Platform' | 'Mark8ly' | 'Infrastructure';

const CATEGORY_TO_APP: Record<string, AppGroup> = {
  'Infrastructure': 'Infrastructure',
  'Identity': 'Platform',
  'Documentation': 'Infrastructure',
  'Core': 'Platform',
  'Commerce': 'Mark8ly',
  'Customer': 'Mark8ly',
  'Catalog': 'Mark8ly',
  'Communication': 'Platform',
  'Vendor': 'Mark8ly',
  'Supporting': 'Mark8ly',
};

export function getAppGroup(category: string): AppGroup {
  return CATEGORY_TO_APP[category] || 'Infrastructure';
}

export function groupServicesByApp(services: ServiceSummary[]): Record<AppGroup, ServiceSummary[]> {
  const groups: Record<AppGroup, ServiceSummary[]> = {
    Platform: [],
    Mark8ly: [],
    Infrastructure: [],
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
