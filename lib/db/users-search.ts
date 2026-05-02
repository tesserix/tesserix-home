// Cross-product user search — Wave 1 sources.
//
// All five sources are bearer-by-email tables we already have grants on.
// Each returns the same envelope so the API route can interleave them.
// Substring match via case-insensitive ILIKE; the API layer is responsible
// for input length checks and rate limiting.

import { tesserixQuery } from "./tesserix";
import { mark8lyQuery } from "./mark8ly";

export interface UserSearchResult {
  /** Source slug, e.g. "leads", "tenants", "invitations". Stable for grouping. */
  readonly source: string;
  /** Human-friendly noun shown above each row, e.g. "Lead", "Tenant owner". */
  readonly kind: string;
  /** The matched email, lowercased. */
  readonly email: string;
  /** Primary display string (name, company, etc.). May equal email if nothing better. */
  readonly label: string;
  /** Secondary line under the label (status, store, "created 2 weeks ago"). */
  readonly sublabel?: string;
  /** Where clicking the result navigates. */
  readonly href: string;
  /** Which DB column matched. Diagnostic; rendered as a small chip. */
  readonly matchedField: string;
  /** ISO timestamp for the result's "freshness" — used for tertiary sort. */
  readonly updatedAt: string | null;
}

const PER_SOURCE_LIMIT = 25;

function asPattern(q: string): string {
  // Substring match. Trim + lowercase already done by caller; also escape
  // SQL LIKE wildcards so a query containing literal % or _ doesn't blow
  // up to thousands of rows.
  const escaped = q.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
  return `%${escaped}%`;
}

// ─── tesserix_admin: leads ─────────────────────────────────────────
interface LeadRow {
  id: string;
  email: string;
  full_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function searchLeads(q: string): Promise<UserSearchResult[]> {
  const res = await tesserixQuery<LeadRow>(
    `SELECT id::text, email, full_name, status, created_at, updated_at
     FROM leads
     WHERE email ILIKE $1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => ({
    source: "leads",
    kind: "Lead",
    email: r.email,
    label: r.full_name?.trim() || r.email,
    sublabel: `${humanizeStatus(r.status)} · captured ${relativeTime(r.created_at)}`,
    href: `/admin/apps/mark8ly/leads`,
    matchedField: "email",
    updatedAt: r.updated_at,
  }));
}

// ─── tesserix_admin: platform_tickets ──────────────────────────────
interface PlatformTicketRow {
  id: string;
  product_id: string;
  ticket_number: string;
  subject: string;
  status: string;
  submitted_by_email: string;
  submitted_by_name: string;
  updated_at: string;
}

export async function searchPlatformTickets(q: string): Promise<UserSearchResult[]> {
  const res = await tesserixQuery<PlatformTicketRow>(
    `SELECT id::text, product_id, ticket_number, subject, status,
            submitted_by_email, submitted_by_name, updated_at
     FROM platform_tickets
     WHERE submitted_by_email ILIKE $1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => ({
    source: "platform_tickets",
    kind: "Platform ticket",
    email: r.submitted_by_email,
    label: r.subject,
    sublabel: `${r.ticket_number} · ${r.product_id} · ${humanizeStatus(r.status)}`,
    href: `/admin/platform-tickets/${r.id}`,
    matchedField: "submitted_by_email",
    updatedAt: r.updated_at,
  }));
}

// ─── mark8ly_platform_api: tenants ─────────────────────────────────
interface TenantRow {
  id: string;
  name: string;
  owner_email: string;
  status: string;
  updated_at: string;
}

export async function searchMark8lyTenants(q: string): Promise<UserSearchResult[]> {
  const res = await mark8lyQuery<TenantRow>(
    "platform_api",
    `SELECT id::text, name, owner_email, status, updated_at
     FROM tenants
     WHERE owner_email ILIKE $1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => ({
    source: "tenants",
    kind: "Tenant owner",
    email: r.owner_email,
    label: r.name,
    sublabel: `mark8ly · ${humanizeStatus(r.status)}`,
    href: `/admin/apps/mark8ly/tenants/${r.id}`,
    matchedField: "owner_email",
    updatedAt: r.updated_at,
  }));
}

// ─── mark8ly_platform_api: invitations ─────────────────────────────
interface InvitationRow {
  id: string;
  email: string;
  tenant_id: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}

export async function searchMark8lyInvitations(q: string): Promise<UserSearchResult[]> {
  const res = await mark8lyQuery<InvitationRow>(
    "platform_api",
    `SELECT i.id::text, i.email, i.tenant_id::text, i.status, i.created_at, i.expires_at
     FROM invitations i
     WHERE i.email ILIKE $1 ESCAPE '\\'
     ORDER BY i.created_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => ({
    source: "invitations",
    kind: "Pending invite",
    email: r.email,
    label: r.email,
    sublabel: `${humanizeStatus(r.status)} · invited ${relativeTime(r.created_at)}${r.expires_at ? ` · expires ${relativeTime(r.expires_at)}` : ""}`,
    href: `/admin/apps/mark8ly/tenants/${r.tenant_id}`,
    matchedField: "email",
    updatedAt: r.created_at,
  }));
}

// ─── mark8ly_platform_api: onboarding_sessions ─────────────────────
interface OnboardingRow {
  id: string;
  email: string;
  email_verified_at: string | null;
  status: string;
  last_activity_at: string;
  updated_at: string;
}

export async function searchMark8lyOnboarding(q: string): Promise<UserSearchResult[]> {
  const res = await mark8lyQuery<OnboardingRow>(
    "platform_api",
    `SELECT id::text, email, email_verified_at, status, last_activity_at, updated_at
     FROM onboarding_sessions
     WHERE email ILIKE $1 ESCAPE '\\'
     ORDER BY last_activity_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => {
    const verified = r.email_verified_at !== null;
    return {
      source: "onboarding",
      kind: "Onboarding session",
      email: r.email,
      label: r.email,
      sublabel: `mark8ly · ${verified ? "verified" : "unverified"} · ${humanizeStatus(r.status)} · ${relativeTime(r.last_activity_at)}`,
      href: `/admin/apps/mark8ly/leads`,
      matchedField: "email",
      updatedAt: r.last_activity_at,
    };
  });
}

// ─── helpers ───────────────────────────────────────────────────────

function humanizeStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) return iso;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
