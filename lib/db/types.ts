// lib/db/types.ts — hand-written row types for both DBs.
//
// Hand-rolled rather than codegen for now (small surface, fewer deps).
// If/when the schema grows or diverges enough that this file becomes a
// chore, switch to kysely-codegen or @databases/pg-typed against
// MARK8LY_DB_HOST + TESSERIX_DB_HOST in CI.

// ──────────────────────────────────────────────────────────────────
// tesserix_admin (own DB)
// ──────────────────────────────────────────────────────────────────

export type AppStatus = "active" | "planned" | "archived" | "deprecated";

export interface AppRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AppStatus;
  db_namespace: string | null;
  db_host: string | null;
  db_port: number | null;
  db_admin_secret_name: string | null;
  db_databases: string[]; // jsonb[]
  primary_domain: string | null;
  admin_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export type LeadStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "converted"
  | "lost";

export interface LeadRow {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  source: string | null;
  status: LeadStatus;
  notes: string | null;
  owner: string | null;
  created_at: Date;
  updated_at: Date;
  last_contacted_at: Date | null;
}

export interface LeadImportRow {
  id: string;
  source: string;
  filename: string | null;
  imported_by: string | null;
  total_rows: number;
  inserted_rows: number;
  updated_rows: number;
  failed_rows: number;
  errors: Array<{ row: number; email?: string; error: string }>;
  created_at: Date;
}

// ──────────────────────────────────────────────────────────────────
// mark8ly_platform_api (cross-DB read/write)
// Mirrored from services/platform-api/internal/tenant/models.go
// ──────────────────────────────────────────────────────────────────

export type TenantStatus = "active" | "suspended" | "archived";

export interface TenantRow {
  id: string;
  name: string;
  owner_user_id: string;
  owner_email: string;
  status: TenantStatus;
  created_at: Date;
  updated_at: Date;
}

// ──────────────────────────────────────────────────────────────────
// mark8ly_marketplace_api (cross-DB read/write)
// Add types here as we build out the dashboard. Start with just stores
// and let the rest grow on demand — premature typing wastes effort
// against tables we may never query.
// ──────────────────────────────────────────────────────────────────

export interface StoreRow {
  id: string;
  tenant_id: string;
  // …extend as queries land. The mark8ly schema is the source of truth;
  // when a column is added there, add it here only when a tesserix-home
  // query needs it.
}
