// Response shapes for tesserix-home's own /api/admin/* platform routes (as
// opposed to the HomeChef Go gateway in contracts.ts). Mirrors the handlers
// under app/api/admin/*; the web admin under app/admin/* consumes the same
// shapes. Extra fields on the wire are ignored.

// ---- Platform dashboard (Overview enrichment) -------------------------------
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'converted' | 'lost';

export interface PlatformDashboard {
  tenants: { total: number; active: number };
  stores: { total: number };
  leads: { by_status: Record<LeadStatus, number>; total: number };
  apps: { active: number };
  generated_at: string;
}

// ---- Platform tickets -------------------------------------------------------
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface TicketRow {
  id: string;
  product_id: string;
  tenant_id: string;
  ticket_number: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  submitted_by_email: string;
  created_at: string;
  updated_at: string;
}

export interface TicketsList {
  summary: { open: number; inProgress: number; resolvedThisWeek: number; urgentOpen: number };
  rows: TicketRow[];
  generatedAt: string;
}

export interface Ticket extends TicketRow {
  description: string;
  submitted_by_name: string;
  submitted_by_user_id: string | null;
  resolved_at: string | null;
}

export interface TicketReply {
  id: string;
  ticket_id: string;
  author_type: 'merchant' | 'platform_admin';
  author_name: string;
  author_email: string | null;
  author_user_id: string | null;
  content: string;
  created_at: string;
}

export interface TicketDetail {
  ticket: Ticket;
  replies: TicketReply[];
}

// ---- Announcements ----------------------------------------------------------
export type AnnouncementSeverity = 'info' | 'warning' | 'maintenance' | 'incident';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience_filter: Record<string, unknown>;
  starts_at: string;
  ends_at: string | null;
  is_published: boolean;
  created_at: string;
}

export interface AnnouncementsList {
  rows: Announcement[];
  generatedAt: string;
}

// ---- Service health ---------------------------------------------------------
export type WorkloadStatus = 'healthy' | 'degraded' | 'down' | 'idle';

export interface WorkloadHealth {
  namespace: string;
  workload: string;
  readyPods: number;
  totalPods: number;
  restarts24h: number;
  totalRestarts: number;
  status: WorkloadStatus;
}

export interface ServiceHealth {
  workloads: WorkloadHealth[];
  totals: {
    workloads: number;
    healthy: number;
    degraded: number;
    down: number;
    idle: number;
    restarts24h: number;
  };
  available: boolean;
  errorMessage: string | null;
  generatedAt: string;
}

// ---- Uptime -----------------------------------------------------------------
export interface UptimeRow {
  product_id: string;
  tenant_id: string;
  hostname: string;
  probes: number;
  successes: number;
  uptime: number; // ratio 0..1
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  last_probed_at: string;
  last_ok: boolean;
  last_error: string | null;
  last_status: number | null;
}

export interface UptimeResponse {
  hours: number;
  rows: UptimeRow[];
  generatedAt: string;
}

// ---- Observability ----------------------------------------------------------
export interface ObsOverview {
  requests: number;
  errorRate: number; // percent 0..100
  p95Ms: number;
  services: number;
}

export interface ObsAppRow extends ObsOverview {
  app: string;
}

export interface ObsServiceRow {
  service: string;
  app: string;
  requests: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ObsTrace {
  traceId: string;
  service: string;
  app: string;
  op: string;
  durationMs: number;
  status: 'Error' | 'OK';
  ts: string;
}

export interface Observability {
  range: string;
  app: string;
  overview: ObsOverview;
  byApp: ObsAppRow[];
  throughput: { t: string; requests: number; errors: number }[];
  latency: { t: string; p50Ms: number; p95Ms: number; p99Ms: number }[];
  statusDist: { status: 'Error' | 'OK'; count: number }[];
  topSlow: { service: string; op: string; count: number; p95Ms: number }[];
  topErrors: { service: string; op: string; errors: number; count: number }[];
  byService: ObsServiceRow[];
  recentTraces: ObsTrace[];
}

// ---- Erasure requests -------------------------------------------------------
export interface ErasureRow {
  id: string;
  tenant_id: string;
  store_id: string;
  customer_email: string;
  requested_at: string;
  status: string;
  processed_at: string | null;
  notes: string | null;
  store_name: string | null;
  hours_pending: number;
}

export interface ErasureRequests {
  summary: {
    pending: number;
    processing: number;
    completedThisWeek: number;
    failed: number;
    oldestPendingHours: number | null;
  };
  rows: ErasureRow[];
  filter: { status: string };
  generatedAt: string;
}

// ---- Break-glass ------------------------------------------------------------
export interface BreakGlassRow {
  tenant_id: string;
  secret_path: string;
  totp_enrolled: boolean;
  last_rotated_at: string | null;
  last_used_at: string | null;
  rotation_scheduled_at: string | null;
  created_at: string;
  tenant_name: string | null;
  days_since_rotation: number | null;
  days_since_use: number | null;
}

export interface BreakGlass {
  summary: { total: number; mfaEnrolled: number; stale90d: number; usedThisWeek: number };
  rows: BreakGlassRow[];
  generatedAt: string;
}

// ---- Users (cross-product directory) ----------------------------------------
export interface UserSearchResult {
  source: string;
  kind: string;
  email: string;
  label: string;
  sublabel?: string;
  href: string;
  matchedField: string;
  updatedAt: string | null;
}

export interface UserSearchResponse {
  query: string;
  results: UserSearchResult[];
  failures: { source: string; message: string }[];
  truncated: boolean;
  generatedAt: string;
}

export interface UserDetailResponse {
  email: string;
  grouped: Record<string, UserSearchResult[]>;
  failures: { source: string; message: string }[];
  totalMatches: number;
  generatedAt: string;
}

// ---- Databases (CNPG health) ------------------------------------------------
export type ClusterStatus = 'healthy' | 'degraded' | 'down';

export interface DbCluster {
  namespace: string;
  cluster: string;
  status: ClusterStatus;
  collectorUp: boolean;
  instances: number;
  readyInstances: number;
  maxReplicationLagSeconds: number | null;
  connections: number | null;
  databaseSizeBytes: number | null;
  postmasterUptimeSeconds: number | null;
  lastAvailableBackupAt: string | null;
  lastFailedBackupAt: string | null;
}

export interface DatabasesResponse {
  clusters: DbCluster[];
  totals: { clusters: number; healthy: number; degraded: number; down: number };
  available: boolean;
  errorMessage: string | null;
  generatedAt: string;
}

// ---- Custom domains ---------------------------------------------------------
export type DomainStatus = 'pending' | 'active' | 'failed' | 'verifying';
export type SSLStatus = 'pending' | 'active' | 'failed';
export type CertStatus = 'pending' | 'issuing' | 'ready' | 'failed';
export type DNSMethod = 'manual' | 'cloudflare';

export interface CustomDomain {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  storeId: string;
  domain: string;
  status: DomainStatus;
  dnsMethod: DNSMethod;
  cnameTarget: string | null;
  sslStatus: SSLStatus;
  certStatus: CertStatus;
  certError: string | null;
  errorMessage: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomDomainsResponse {
  domains: CustomDomain[];
}

// ---- Outbox -----------------------------------------------------------------
export type OutboxDatabase = 'platform_api' | 'marketplace_api';
export type OutboxStatus = 'pending' | 'in_flight' | 'completed' | 'dead';

export interface OutboxRow {
  database: OutboxDatabase;
  id: string;
  kind: string;
  status: OutboxStatus;
  attempts: number | null;
  ageSeconds: number;
  lastError: string | null;
  tenantId: string | null;
  aggregate: string | null;
  createdAt: string;
}

export interface OutboxDatabaseSummary {
  database: OutboxDatabase;
  available: boolean;
  pending: number;
  inFlight: number;
  stuck: number;
  dead: number;
  oldestPendingAgeSeconds: number | null;
  errorMessage: string | null;
}

export interface OutboxResponse {
  summaries: OutboxDatabaseSummary[];
  recent: OutboxRow[];
  generatedAt: string;
}
