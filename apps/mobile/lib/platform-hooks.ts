// platform-hooks.ts — TanStack Query hooks over tesserix-home's own /api/admin/*
// platform routes (via the `plat` client). Reliability/monitoring screens poll;
// list screens refetch on focus/pull. Mutations invalidate their list key.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { plat } from './api';
import type {
  PlatformDashboard,
  TicketsList,
  TicketDetail,
  TicketStatus,
  AnnouncementsList,
  Announcement,
  AnnouncementSeverity,
  ServiceHealth,
  UptimeResponse,
  Observability,
  TraceDetail,
  ErasureRequests,
  BreakGlass,
  UserSearchResponse,
  UserDetailResponse,
  DatabasesResponse,
  CustomDomainsResponse,
  OutboxResponse,
  PlatformSupportStats,
} from './platform-contracts';

export const pk = {
  dashboard: ['plat', 'dashboard'] as const,
  tickets: (p: object) => ['plat', 'tickets', p] as const,
  ticket: (id: string) => ['plat', 'ticket', id] as const,
  announcements: ['plat', 'announcements'] as const,
  health: ['plat', 'health'] as const,
  uptime: (hours: number) => ['plat', 'uptime', hours] as const,
  observability: (p: object) => ['plat', 'observability', p] as const,
  trace: (id: string) => ['plat', 'trace', id] as const,
  erasure: (status: string) => ['plat', 'erasure', status] as const,
  breakGlass: ['plat', 'break-glass'] as const,
  userSearch: (q: string) => ['plat', 'user-search', q] as const,
  userDetail: (email: string) => ['plat', 'user', email] as const,
  databases: ['plat', 'databases'] as const,
  domains: ['plat', 'domains'] as const,
  outbox: ['plat', 'outbox'] as const,
  supportAnalytics: ['plat', 'support-analytics'] as const,
};

// ---- Dashboard --------------------------------------------------------------
export const usePlatformDashboard = () =>
  useQuery({ queryKey: pk.dashboard, queryFn: () => plat.get<PlatformDashboard>('/dashboard') });

// ---- Tickets ----------------------------------------------------------------
export const useTicketsList = (p: { status?: string; priority?: string; product?: string }) =>
  useQuery({
    queryKey: pk.tickets(p),
    queryFn: () =>
      plat.get<TicketsList>('/platform-tickets', {
        status: p.status || undefined,
        priority: p.priority || undefined,
        product: p.product || undefined,
      }),
  });

export const useTicket = (id: string) =>
  useQuery({ queryKey: pk.ticket(id), queryFn: () => plat.get<TicketDetail>(`/platform-tickets/${id}`), enabled: !!id });

export function useSetPlatformTicketStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: TicketStatus) =>
      plat.patch<{ ticket: unknown }>(`/platform-tickets/${id}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk.ticket(id) });
      qc.invalidateQueries({ queryKey: ['plat', 'tickets'] });
    },
  });
}

export function useReplyToTicket(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { content: string; newStatus?: TicketStatus }) =>
      plat.post<{ reply: unknown }>(`/platform-tickets/${id}/replies`, a),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pk.ticket(id) });
      qc.invalidateQueries({ queryKey: ['plat', 'tickets'] });
    },
  });
}

// ---- Announcements ----------------------------------------------------------
export const useAnnouncements = () =>
  useQuery({ queryKey: pk.announcements, queryFn: () => plat.get<AnnouncementsList>('/platform-announcements') });

export function useCreateAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { title: string; body: string; severity: AnnouncementSeverity }) =>
      plat.post<{ announcement: Announcement }>('/platform-announcements', { ...a, isPublished: false }),
    onSuccess: () => qc.invalidateQueries({ queryKey: pk.announcements }),
  });
}

export function useToggleAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; isPublished: boolean }) =>
      plat.patch<{ announcement: Announcement }>(`/platform-announcements/${a.id}`, { isPublished: a.isPublished }),
    onSuccess: () => qc.invalidateQueries({ queryKey: pk.announcements }),
  });
}

// ---- Reliability ------------------------------------------------------------
export const useServiceHealth = () =>
  useQuery({ queryKey: pk.health, queryFn: () => plat.get<ServiceHealth>('/service-health'), refetchInterval: 30_000 });

export const useUptime = (hours: number) =>
  useQuery({ queryKey: pk.uptime(hours), queryFn: () => plat.get<UptimeResponse>('/uptime', { hours }), refetchInterval: 60_000 });

export const useObservability = (p: { range: string; app: string }) =>
  useQuery({
    queryKey: pk.observability(p),
    queryFn: () => plat.get<Observability>('/observability', { range: p.range, app: p.app || undefined }),
    refetchInterval: 30_000,
  });

export const useTrace = (id: string) =>
  useQuery({
    queryKey: pk.trace(id),
    queryFn: () => plat.get<TraceDetail>('/observability/trace', { id }),
    enabled: !!id,
  });

// ---- Data & access ----------------------------------------------------------
export const useUserSearch = (q: string) =>
  useQuery({
    queryKey: pk.userSearch(q),
    queryFn: () => plat.get<UserSearchResponse>('/users/search', { q }),
    enabled: q.trim().length >= 3,
  });

export const useUserDetail = (email: string) =>
  useQuery({
    queryKey: pk.userDetail(email),
    queryFn: () => plat.get<UserDetailResponse>(`/users/${encodeURIComponent(email)}`),
    enabled: !!email,
  });

export const useDatabases = () =>
  useQuery({ queryKey: pk.databases, queryFn: () => plat.get<DatabasesResponse>('/cnpg-health'), refetchInterval: 30_000 });

export const useCustomDomains = () =>
  useQuery({ queryKey: pk.domains, queryFn: () => plat.get<CustomDomainsResponse>('/custom-domains'), refetchInterval: 60_000 });

export function useDomainAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; action: 'verify' | 'refresh-status' }) =>
      plat.post(`/custom-domains/${a.id}/${a.action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: pk.domains }),
  });
}

export const useOutbox = () =>
  useQuery({ queryKey: pk.outbox, queryFn: () => plat.get<OutboxResponse>('/outbox'), refetchInterval: 30_000 });

// ---- Governance -------------------------------------------------------------
export const useErasureRequests = (status: string) =>
  useQuery({ queryKey: pk.erasure(status), queryFn: () => plat.get<ErasureRequests>('/erasure-requests', { status }) });

export const useBreakGlass = () =>
  useQuery({ queryKey: pk.breakGlass, queryFn: () => plat.get<BreakGlass>('/break-glass') });

// ---- Support analytics -------------------------------------------------------
export const useSupportAnalytics = () =>
  useQuery({
    queryKey: pk.supportAnalytics,
    queryFn: () => plat.get<PlatformSupportStats>('/analytics/support'),
    refetchInterval: 30_000,
  });
