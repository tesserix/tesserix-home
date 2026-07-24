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
  name: string | null;
  company: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function searchLeads(q: string): Promise<UserSearchResult[]> {
  // Match across email, name, AND company so a search for "bondi" or
  // "Acme" finds leads even when the email doesn't carry the brand
  // (e.g., a Gmail address attached to a company).
  const res = await tesserixQuery<LeadRow>(
    `SELECT id::text, email, name, company, status, created_at, updated_at
     FROM leads
     WHERE email   ILIKE $1 ESCAPE '\\'
        OR name    ILIKE $1 ESCAPE '\\'
        OR company ILIKE $1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => {
    const display = r.name?.trim() || r.email;
    const sub = [
      r.company?.trim(),
      humanizeStatus(r.status),
      `captured ${relativeTime(r.created_at)}`,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      source: "leads",
      kind: "Lead",
      email: r.email,
      label: display,
      sublabel: sub,
      href: `/admin/apps/mark8ly/leads`,
      matchedField: matchedField(q, { email: r.email, name: r.name, company: r.company }),
      updatedAt: r.updated_at,
    };
  });
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
  // Match across the tenant's display name AND the owner's email so a
  // search for "bondi" finds "the-bondi-store" even though the owner's
  // email may be on Gmail.
  const res = await mark8lyQuery<TenantRow>(
    "platform_api",
    `SELECT id::text, name, owner_email, status, updated_at
     FROM tenants
     WHERE owner_email ILIKE $1 ESCAPE '\\'
        OR name        ILIKE $1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => ({
    source: "tenants",
    kind: "Tenant",
    email: r.owner_email,
    label: r.name,
    sublabel: `mark8ly · ${humanizeStatus(r.status)} · ${r.owner_email}`,
    href: `/admin/apps/mark8ly/tenants/${r.id}`,
    matchedField: matchedField(q, { name: r.name, owner_email: r.owner_email }),
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

// ─── mark8ly_marketplace_api: customer_profiles ────────────────────
interface CustomerProfileRow {
  id: string;
  tenant_id: string;
  store_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  store_name: string | null;
  store_slug: string | null;
  updated_at: string;
}

export async function searchMark8lyCustomers(q: string): Promise<UserSearchResult[]> {
  // Join stores so the result row can show "customer of {store name}"
  // without a second round trip. The store_id ↦ tenant_id mapping lets
  // us deep-link to the existing tenant detail page.
  const res = await mark8lyQuery<CustomerProfileRow>(
    "marketplace_api",
    `SELECT cp.id::text, cp.tenant_id::text, cp.store_id::text, cp.email,
            cp.first_name, cp.last_name, cp.status, cp.updated_at,
            s.name AS store_name, s.slug AS store_slug
     FROM customer_profiles cp
     LEFT JOIN stores s ON s.id = cp.store_id
     WHERE cp.email      ILIKE $1 ESCAPE '\\'
        OR cp.first_name ILIKE $1 ESCAPE '\\'
        OR cp.last_name  ILIKE $1 ESCAPE '\\'
     ORDER BY cp.updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => {
    const fullName = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
    const storeLabel = r.store_name ?? r.store_slug ?? "unknown store";
    return {
      source: "customers",
      kind: "Storefront customer",
      email: r.email,
      label: fullName || r.email,
      sublabel: `customer of ${storeLabel} · ${humanizeStatus(r.status)}`,
      href: `/admin/apps/mark8ly/tenants/${r.tenant_id}`,
      matchedField: matchedField(q, {
        email: r.email,
        first_name: r.first_name,
        last_name: r.last_name,
      }),
      updatedAt: r.updated_at,
    };
  });
}

// ─── mark8ly_marketplace_api: user_profiles ────────────────────────
interface UserProfileRow {
  user_id: string;
  email: string;
  display_name: string | null;
  updated_at: string;
}

export async function searchMark8lyUsers(q: string): Promise<UserSearchResult[]> {
  // user_profiles is mark8ly's platform-wide identity table — one row per
  // human, regardless of which tenant(s) they belong to. Useful as a
  // confirmation signal ("this email is a registered mark8ly user")
  // even when the same email also appears in tenants/customers.
  // Result row links back to the full /admin/search page so the operator
  // can see every other source for the same email at a glance.
  const res = await mark8lyQuery<UserProfileRow>(
    "marketplace_api",
    `SELECT user_id::text, email, display_name, updated_at
     FROM user_profiles
     WHERE email        ILIKE $1 ESCAPE '\\'
        OR display_name ILIKE $1 ESCAPE '\\'
     ORDER BY updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => ({
    source: "mark8ly_users",
    kind: "Mark8ly user",
    email: r.email,
    label: r.display_name?.trim() || r.email,
    sublabel: `mark8ly account · ${r.email}`,
    href: `/admin/search?q=${encodeURIComponent(r.email)}`,
    matchedField: matchedField(q, { email: r.email, display_name: r.display_name }),
    updatedAt: r.updated_at,
  }));
}

// ─── mark8ly_marketplace_api: tickets (customer-side) ──────────────
interface MerchantTicketRow {
  id: string;
  tenant_id: string;
  store_id: string;
  ticket_number: string;
  subject: string;
  status: string;
  submitted_by_name: string;
  submitted_by_email: string;
  store_name: string | null;
  updated_at: string;
}

export async function searchMark8lyMerchantTickets(q: string): Promise<UserSearchResult[]> {
  // Customer-facing support tickets — distinct from tesserix_admin.platform_tickets
  // which are merchant-to-platform. These are customer-to-merchant, filed via
  // the storefront. Joining stores gives us a meaningful sublabel.
  const res = await mark8lyQuery<MerchantTicketRow>(
    "marketplace_api",
    `SELECT t.id::text, t.tenant_id::text, t.store_id::text, t.ticket_number,
            t.subject, t.status, t.submitted_by_name, t.submitted_by_email,
            t.updated_at, s.name AS store_name
     FROM tickets t
     LEFT JOIN stores s ON s.id = t.store_id
     WHERE t.submitted_by_email ILIKE $1 ESCAPE '\\'
        OR t.submitted_by_name  ILIKE $1 ESCAPE '\\'
     ORDER BY t.updated_at DESC
     LIMIT ${PER_SOURCE_LIMIT}`,
    [asPattern(q)],
  );
  return res.rows.map((r) => ({
    source: "merchant_tickets",
    kind: "Customer ticket",
    email: r.submitted_by_email,
    label: r.subject,
    sublabel: `${r.ticket_number} · ${r.store_name ?? "store"} · ${humanizeStatus(r.status)}`,
    // No detail page for customer-side tickets in tesserix-home yet —
    // route to the tenant detail page where the operator can drill into
    // the merchant admin if needed.
    href: `/admin/apps/mark8ly/tenants/${r.tenant_id}`,
    matchedField: matchedField(q, {
      submitted_by_email: r.submitted_by_email,
      submitted_by_name: r.submitted_by_name,
    }),
    updatedAt: r.updated_at,
  }));
}

// ─── helpers ───────────────────────────────────────────────────────

function matchedField(
  q: string,
  fields: Readonly<Record<string, string | null | undefined>>,
): string {
  const needle = q.toLowerCase();
  for (const [name, value] of Object.entries(fields)) {
    if (value && value.toLowerCase().includes(needle)) return name;
  }
  return Object.keys(fields)[0] ?? "";
}

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
