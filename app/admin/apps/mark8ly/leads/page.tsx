"use client";

// Leads management page. Lists current leads from /api/admin/leads,
// supports filters (status, source, has_website, free-text search),
// status edit, and a paste-JSON / CSV import drawer.
//
// As of migration 0007 leads support multi-channel contact (email,
// instagram_handle, phone) and structured filterable fields. The
// table prefers email when present, falls back to @handle. The send-
// email modal is disabled for handle-only rows since SendGrid needs
// an email recipient.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Plus,
  RefreshCw,
  Upload,
  Mail,
  Instagram,
  Globe,
  GlobeLock,
  Search,
  MessageSquare,
  Star,
  X,
  UserPlus,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";

import { AdminHeader } from "@/components/admin/header";
import { LEAD_STATUSES } from "@/lib/leads/schema";

interface Lead {
  id: string;
  email: string | null;
  instagram_handle: string | null;
  phone: string | null;
  name: string | null;
  company: string | null;
  location: string | null;
  category: string[];
  has_website: boolean | null;
  website_url: string | null;
  biography: string | null;
  tags: string[];
  followers_count: number | null;
  posts_count: number | null;
  is_starred: boolean;
  source: string | null;
  status: string;
  notes: string | null;
  owner: string | null;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  activity_count?: number;
}

interface Activity {
  id: string;
  lead_id: string;
  kind:
    | "note"
    | "dm_sent"
    | "dm_received"
    | "email_sent"
    | "email_received"
    | "call"
    | "status_change"
    | "assigned";
  actor_email: string;
  body: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface ImportSummary {
  import_id: string;
  total: number;
  inserted: number;
  updated: number;
  failed: number;
  errors: Array<{
    row: number;
    email?: string | null;
    instagram_handle?: string | null;
    error: string;
  }>;
}

const STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  ...LEAD_STATUSES.map((s) => ({ value: s, label: s })),
];

const HAS_WEBSITE_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "Any" },
  { value: "false", label: "No website" },
  { value: "true", label: "Has website" },
  { value: "unknown", label: "Unknown" },
];

const COUNTRY_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "india", label: "India" },
  { value: "australia", label: "Australia" },
];

// Min-follower bands. Empty value = no minimum (Any). Values map 1:1
// to the API's `min_followers` integer; the API excludes NULL rows
// when the param is set, so "Any" deliberately omits the param to
// keep handle-only / non-IG leads visible by default.
const MIN_FOLLOWERS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Any" },
  { value: "100", label: "100+" },
  { value: "1000", label: "1k+" },
  { value: "10000", label: "10k+" },
];

// Min-posts bands. Same NULL-exclusion semantics as min_followers; an
// active shop with 100+ posts reads very differently from one with 5.
const MIN_POSTS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Any" },
  { value: "10", label: "10+" },
  { value: "100", label: "100+" },
  { value: "500", label: "500+" },
];

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [hasWebsiteFilter, setHasWebsiteFilter] = useState<string>("all");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [minFollowersFilter, setMinFollowersFilter] = useState<string>("");
  const [minPostsFilter, setMinPostsFilter] = useState<string>("");
  const [starredOnly, setStarredOnly] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState<boolean>(false);
  const [sendDialogLead, setSendDialogLead] = useState<Lead | null>(null);
  const [activityLead, setActivityLead] = useState<Lead | null>(null);

  // Debounce free-text search so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (hasWebsiteFilter !== "all") params.set("has_website", hasWebsiteFilter);
      if (countryFilter !== "all") params.set("country", countryFilter);
      if (minFollowersFilter) params.set("min_followers", minFollowersFilter);
      if (minPostsFilter) params.set("min_posts", minPostsFilter);
      if (starredOnly) params.set("starred", "true");
      if (debouncedSearch) params.set("q", debouncedSearch);
      const url = `/api/admin/leads${params.size > 0 ? `?${params.toString()}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { leads: Lead[] };
      setLeads(data.leads);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filter, sourceFilter, hasWebsiteFilter, countryFilter, minFollowersFilter, minPostsFilter, starredOnly, debouncedSearch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateStatus = useCallback(
    async (id: string, status: string) => {
      const res = await fetch(`/api/admin/leads/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        await refresh();
      }
    },
    [refresh],
  );

  // Optimistic star toggle — flips the local row first so the UI is
  // instant, PATCHes the server, and rolls back on failure. Doesn't
  // call refresh() on success: keeping the in-place mutation avoids
  // a full table reflow on every star click.
  const toggleStar = useCallback(
    async (id: string, current: boolean) => {
      const next = !current;
      setLeads((rows) =>
        rows.map((r) => (r.id === id ? { ...r, is_starred: next } : r)),
      );
      try {
        const res = await fetch(`/api/admin/leads/${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_starred: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        // Roll back on failure
        setLeads((rows) =>
          rows.map((r) => (r.id === id ? { ...r, is_starred: current } : r)),
        );
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const totalsByStatus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of LEAD_STATUSES) m[s] = 0;
    for (const l of leads) m[l.status] = (m[l.status] ?? 0) + 1;
    return m;
  }, [leads]);

  // KPI roll-up across the (filtered) result set. We compute against
  // `leads` rather than a separate count endpoint so the strip reflects
  // whatever the operator is currently filtering — e.g. selecting
  // "No website" shows how many of those are owned / contacted.
  // Date.now() can't be called inside render (react-hooks/purity), so
  // we keep the wall-clock cutoff in a useEffect-driven state slot.
  const [sevenDaysAgo, setSevenDaysAgo] = useState<number>(0);
  useEffect(() => {
    setSevenDaysAgo(Date.now() - 7 * 24 * 60 * 60 * 1000);
  }, [leads]);
  const kpis = useMemo(() => {
    return {
      total: leads.length,
      owned: leads.filter((l) => l.owner).length,
      contactedRecently: leads.filter(
        (l) =>
          l.last_contacted_at &&
          new Date(l.last_contacted_at).getTime() >= sevenDaysAgo,
      ).length,
      noWebsite: leads.filter((l) => l.has_website === false).length,
    };
  }, [leads, sevenDaysAgo]);

  // Build the source filter pills from the current row set so we don't
  // hard-code a list. As soon as a new source name lands in the data,
  // the pill appears.
  const sourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) if (l.source) set.add(l.source);
    return Array.from(set).sort();
  }, [leads]);

  return (
    <div className="flex h-full flex-col">
      <AdminHeader title="Leads" />
      <div className="flex-1 space-y-4 p-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiTile label="Total" value={kpis.total} hint="in current filter" />
          <KpiTile label="Owned" value={kpis.owned} hint="have an assignee" />
          <KpiTile
            label="Contacted (7d)"
            value={kpis.contactedRecently}
            hint="recent outreach"
          />
          <KpiTile
            label="No website"
            value={kpis.noWebsite}
            hint="ICP fit for mark8ly"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <FilterRow label="Status">
              {STATUS_FILTERS.map((f) => (
                <FilterPill
                  key={f.value}
                  active={filter === f.value}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                  {f.value !== "all" && totalsByStatus[f.value] > 0 ? (
                    <span className="ml-1 opacity-70">{totalsByStatus[f.value]}</span>
                  ) : null}
                </FilterPill>
              ))}
            </FilterRow>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm hover:border-foreground/40"
            >
              <RefreshCw className={"h-3 w-3 " + (loading ? "animate-spin" : "")} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setImportOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:bg-foreground/90"
            >
              <Upload className="h-3 w-3" />
              Import
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <FilterRow label="Website">
            {HAS_WEBSITE_FILTERS.map((f) => (
              <FilterPill
                key={f.value}
                active={hasWebsiteFilter === f.value}
                onClick={() => setHasWebsiteFilter(f.value)}
              >
                {f.label}
              </FilterPill>
            ))}
          </FilterRow>
          <FilterRow label="Country">
            {COUNTRY_FILTERS.map((f) => (
              <FilterPill
                key={f.value}
                active={countryFilter === f.value}
                onClick={() => setCountryFilter(f.value)}
              >
                {f.label}
              </FilterPill>
            ))}
          </FilterRow>
          <FilterRow label="Followers">
            {MIN_FOLLOWERS_FILTERS.map((f) => (
              <FilterPill
                key={f.value || "any"}
                active={minFollowersFilter === f.value}
                onClick={() => setMinFollowersFilter(f.value)}
              >
                {f.label}
              </FilterPill>
            ))}
          </FilterRow>
          <FilterRow label="Posts">
            {MIN_POSTS_FILTERS.map((f) => (
              <FilterPill
                key={f.value || "any"}
                active={minPostsFilter === f.value}
                onClick={() => setMinPostsFilter(f.value)}
              >
                {f.label}
              </FilterPill>
            ))}
          </FilterRow>
          <FilterRow label="Starred">
            <FilterPill active={!starredOnly} onClick={() => setStarredOnly(false)}>
              All
            </FilterPill>
            <FilterPill active={starredOnly} onClick={() => setStarredOnly(true)}>
              <Star
                className="mr-1 inline h-3 w-3"
                fill={starredOnly ? "currentColor" : "none"}
                aria-hidden="true"
              />
              Starred only
            </FilterPill>
          </FilterRow>
          {sourceOptions.length > 0 && (
            <FilterRow label="Source">
              <FilterPill
                active={sourceFilter === "all"}
                onClick={() => setSourceFilter("all")}
              >
                All
              </FilterPill>
              {sourceOptions.map((s) => (
                <FilterPill
                  key={s}
                  active={sourceFilter === s}
                  onClick={() => setSourceFilter(s)}
                >
                  {s}
                </FilterPill>
              ))}
            </FilterRow>
          )}
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search email / handle / name / company / location"
              className="w-72 rounded-md border border-border bg-background py-1.5 pl-7 pr-3 text-xs"
            />
          </div>
        </div>

        {importOpen ? (
          <ImportDrawer
            onClose={() => setImportOpen(false)}
            onComplete={() => {
              setImportOpen(false);
              void refresh();
            }}
          />
        ) : null}

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
            Error: {error}
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full min-w-[1280px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="w-8 px-2 py-3"></th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3">Name / Company</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3 text-right">Followers</th>
                <th className="px-4 py-3 text-right">Posts</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Activity</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {leads.length === 0 && !loading ? (
                <tr>
                  <td colSpan={13} className="px-4 py-8 text-center text-muted-foreground">
                    {debouncedSearch || filter !== "all" || hasWebsiteFilter !== "all" || sourceFilter !== "all" || countryFilter !== "all" || minFollowersFilter || minPostsFilter || starredOnly
                      ? "No leads match the current filters."
                      : "No leads. Click Import to add some."}
                  </td>
                </tr>
              ) : (
                leads.map((l) => (
                  <LeadRow
                    key={l.id}
                    lead={l}
                    onStatus={(v) => void updateStatus(l.id, v)}
                    onEmail={() => setSendDialogLead(l)}
                    onOpenActivity={() => setActivityLead(l)}
                    onToggleStar={() => void toggleStar(l.id, l.is_starred)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {sendDialogLead && (
        <SendEmailDialog
          lead={sendDialogLead}
          onClose={() => setSendDialogLead(null)}
          onSent={() => {
            setSendDialogLead(null);
            void refresh();
          }}
        />
      )}

      {activityLead && (
        <ActivityDrawer
          lead={activityLead}
          onClose={() => {
            setActivityLead(null);
            void refresh(); // pick up activity_count + assignee changes
          }}
        />
      )}
    </div>
  );
}

function KpiTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 text-xl font-medium tabular-nums">{value}</p>
      {hint ? (
        <p className="text-[10px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full border px-3 py-1 text-xs capitalize transition-colors " +
        (active
          ? "border-foreground bg-foreground text-background"
          : "border-border hover:border-foreground/40")
      }
    >
      {children}
    </button>
  );
}

function LeadRow({
  lead,
  onStatus,
  onEmail,
  onOpenActivity,
  onToggleStar,
}: {
  lead: Lead;
  onStatus: (v: string) => void;
  onEmail: () => void;
  onOpenActivity: () => void;
  onToggleStar: () => void;
}) {
  const canEmail = Boolean(lead.email);
  return (
    <tr className="border-b border-border last:border-0">
      <td className="w-8 px-2 py-3">
        <button
          type="button"
          onClick={onToggleStar}
          className={
            "inline-flex h-6 w-6 items-center justify-center rounded transition-colors " +
            (lead.is_starred
              ? "text-amber-500 hover:text-amber-600"
              : "text-muted-foreground/40 hover:text-amber-500")
          }
          aria-label={lead.is_starred ? "Unstar lead" : "Star lead"}
          aria-pressed={lead.is_starred}
          title={lead.is_starred ? "Unstar (priority bookmark)" : "Star (priority bookmark)"}
        >
          <Star
            className="h-4 w-4"
            fill={lead.is_starred ? "currentColor" : "none"}
            aria-hidden="true"
          />
        </button>
      </td>
      <td className="px-4 py-3">
        {lead.email ? (
          <span className="block truncate font-mono text-xs">{lead.email}</span>
        ) : lead.instagram_handle ? (
          <a
            href={`https://www.instagram.com/${lead.instagram_handle}/`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
            title="Open on Instagram"
          >
            <Instagram className="h-3 w-3" aria-hidden="true" />
            @{lead.instagram_handle}
          </a>
        ) : lead.phone ? (
          <span className="font-mono text-xs">{lead.phone}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="block">{lead.name ?? "—"}</span>
        {lead.company && lead.company !== lead.name ? (
          <span className="block text-xs text-muted-foreground">{lead.company}</span>
        ) : null}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {lead.location ?? "—"}
      </td>
      <td className="px-4 py-3">
        {lead.category.length > 0 ? (
          <CategoryBadges items={lead.category} />
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <SiteBadge has={lead.has_website} url={lead.website_url} />
      </td>
      <td className="px-4 py-3 text-right text-xs tabular-nums">
        {lead.followers_count !== null && lead.followers_count !== undefined ? (
          <span title={`${lead.followers_count.toLocaleString()} followers`}>
            {formatFollowers(lead.followers_count)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right text-xs tabular-nums">
        {lead.posts_count !== null && lead.posts_count !== undefined ? (
          <span title={`${lead.posts_count.toLocaleString()} posts`}>
            {formatFollowers(lead.posts_count)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {lead.source ?? "—"}
      </td>
      <td className="px-4 py-3 text-xs">
        {lead.owner ? (
          <span
            className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px]"
            title={lead.owner}
          >
            {lead.owner.split("@")[0]}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <Select value={lead.status} onValueChange={onStatus}>
          <SelectTrigger className="h-7 w-32 text-xs capitalize">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEAD_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>
      <td className="px-4 py-3">
        <button
          onClick={onOpenActivity}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          aria-label={`Open activity timeline for ${lead.name ?? lead.instagram_handle ?? "lead"}`}
          title="Notes, conversations, status history"
        >
          <MessageSquare className="h-3 w-3" aria-hidden="true" />
          {lead.activity_count ?? 0}
        </button>
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {new Date(lead.created_at).toLocaleDateString()}
      </td>
      <td className="px-4 py-3">
        <button
          onClick={onEmail}
          disabled={!canEmail}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label={canEmail ? `Send email to ${lead.email}` : "No email — use Instagram DM"}
          title={canEmail ? `Send email to ${lead.email}` : "No email on file — reach out via Instagram DM instead"}
        >
          <Mail className="h-3 w-3" aria-hidden="true" />
          Email
        </button>
      </td>
    </tr>
  );
}

const ACTIVITY_KIND_LABEL: Record<Activity["kind"], string> = {
  note: "Note",
  dm_sent: "DM sent",
  dm_received: "DM received",
  email_sent: "Email sent",
  email_received: "Email received",
  call: "Call",
  status_change: "Status",
  assigned: "Assignment",
};

const ACTIVITY_KIND_TONE: Record<Activity["kind"], string> = {
  note: "bg-muted text-muted-foreground",
  dm_sent: "bg-violet-50 text-violet-700",
  dm_received: "bg-violet-50 text-violet-700",
  email_sent: "bg-sky-50 text-sky-700",
  email_received: "bg-sky-50 text-sky-700",
  call: "bg-emerald-50 text-emerald-700",
  status_change: "bg-amber-50 text-amber-700",
  assigned: "bg-amber-50 text-amber-700",
};

const COMPOSER_KINDS: ReadonlyArray<{ value: Activity["kind"]; label: string }> = [
  { value: "note", label: "Note" },
  { value: "dm_sent", label: "DM sent" },
  { value: "dm_received", label: "DM received" },
  { value: "email_received", label: "Email received" },
  { value: "call", label: "Call" },
];

function ActivityDrawer({
  lead,
  onClose,
}: {
  lead: Lead;
  onClose: () => void;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerKind, setComposerKind] = useState<Activity["kind"]>("note");
  const [composerBody, setComposerBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ownerInput, setOwnerInput] = useState(lead.owner ?? "");
  const [savingOwner, setSavingOwner] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/leads/${lead.id}/activities`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { activities: Activity[] };
      setActivities(data.activities);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [lead.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    if (!composerBody.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/leads/${lead.id}/activities`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: composerKind, body: composerBody.trim() }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      setComposerBody("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function saveOwner() {
    setSavingOwner(true);
    try {
      const next = ownerInput.trim() || null;
      const res = await fetch(`/api/admin/leads/${lead.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: next }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      // PATCH auto-logs an `assigned` activity, so reload.
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingOwner(false);
    }
  }

  const headline =
    lead.name ?? (lead.instagram_handle ? `@${lead.instagram_handle}` : lead.email);

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="flex w-full max-w-lg flex-col bg-card shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-medium">{headline}</h3>
            <p className="truncate text-xs text-muted-foreground">
              {lead.email ?? `@${lead.instagram_handle ?? "—"}`}
              {lead.location ? ` · ${lead.location}` : ""}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-4 border-b border-border px-5 py-4">
          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Owner
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                value={ownerInput}
                onChange={(e) => setOwnerInput(e.target.value)}
                placeholder="email@example.com (blank to unassign)"
                className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
              />
              <button
                onClick={() => void saveOwner()}
                disabled={savingOwner || ownerInput.trim() === (lead.owner ?? "")}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-40"
              >
                <UserPlus className="h-3 w-3" aria-hidden="true" />
                {savingOwner ? "…" : "Assign"}
              </button>
            </div>
          </div>
        </div>

        <div className="space-y-3 border-b border-border px-5 py-4">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Log activity
          </p>
          <div className="flex flex-wrap gap-1">
            {COMPOSER_KINDS.map((k) => (
              <button
                key={k.value}
                onClick={() => setComposerKind(k.value)}
                aria-pressed={composerKind === k.value}
                className={
                  "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors " +
                  (composerKind === k.value
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:border-foreground/40")
                }
              >
                {k.label}
              </button>
            ))}
          </div>
          <textarea
            value={composerBody}
            onChange={(e) => setComposerBody(e.target.value)}
            rows={3}
            placeholder="What happened?"
            className="w-full rounded-md border border-border bg-background p-2 text-sm"
          />
          <div className="flex justify-end">
            <button
              onClick={() => void submit()}
              disabled={submitting || composerBody.trim().length === 0}
              className="rounded-md bg-foreground px-3 py-1 text-xs text-background disabled:opacity-40"
            >
              {submitting ? "Logging…" : "Log"}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {loading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : activities.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No activity yet. Status changes, sent emails, and notes you log here will show up.
            </p>
          ) : (
            <ol className="space-y-3">
              {activities.map((a) => (
                <li key={a.id} className="rounded-md border border-border bg-background p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${ACTIVITY_KIND_TONE[a.kind]}`}
                    >
                      {ACTIVITY_KIND_LABEL[a.kind]}
                    </span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {new Date(a.created_at).toLocaleString()}
                    </span>
                  </div>
                  {a.body ? (
                    <p className="mt-1.5 whitespace-pre-wrap text-xs">{a.body}</p>
                  ) : null}
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    by {a.actor_email}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact follower count for the table cell. Full value lives in the
// `title` attribute so hover surfaces the exact number.
function formatFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function CategoryBadges({ items }: { items: string[] }) {
  const visible = items.slice(0, 2);
  const overflow = items.length - visible.length;
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((c) => (
        <span
          key={c}
          className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
        >
          {c}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          title={items.slice(2).join(", ")}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

function SiteBadge({
  has,
  url,
}: {
  has: boolean | null;
  url: string | null;
}) {
  if (has === true) {
    const icon = <Globe className="h-3 w-3" aria-hidden="true" />;
    if (url) {
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700 hover:bg-emerald-100"
          title={url}
        >
          {icon}
          Has site
        </a>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
        {icon}
        Has site
      </span>
    );
  }
  if (has === false) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700"
        title="No website yet — strong fit for mark8ly outreach"
      >
        <GlobeLock className="h-3 w-3" aria-hidden="true" />
        No site
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
      ?
    </span>
  );
}

interface SendEmailDialogProps {
  lead: Lead;
  onClose: () => void;
  onSent: () => void;
}

interface LeadTemplateOption {
  key: string;
  label: string;
  status: "published" | "draft";
  product: string;
}

function SendEmailDialog({ lead, onClose, onSent }: SendEmailDialogProps) {
  const [templates, setTemplates] = useState<LeadTemplateOption[]>([]);
  const [picked, setPicked] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/lead-templates", { credentials: "include" })
      .then((r) => r.json())
      .then((d: { templates: LeadTemplateOption[] }) => {
        if (cancelled) return;
        const published = d.templates.filter((t) => t.status === "published");
        setTemplates(published);
        if (published.length > 0) setPicked(published[0].key);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  async function send() {
    if (!picked || !lead.email) return;
    setSending(true);
    setError(null);
    try {
      const idempotencyKey = `lead-${lead.id}-${picked}-${Date.now()}`;
      const res = await fetch(`/api/admin/leads/${lead.id}/send-email`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateKey: picked, idempotencyKey }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        sent?: boolean;
        recipient?: string;
        message?: string;
      };
      if (!res.ok) {
        setError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      setResult(`Sent to ${body.recipient ?? lead.email}`);
      setTimeout(onSent, 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const recipient = lead.email ?? lead.instagram_handle;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl">
        <header className="mb-3">
          <h3 className="text-base font-medium">Send email to lead</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {recipient}
            {lead.name ? ` · ${lead.name}` : ""}
            {lead.company ? ` · ${lead.company}` : ""}
          </p>
        </header>

        {!lead.email ? (
          <p className="rounded-md border border-amber-300/40 bg-amber-50 p-3 text-xs text-amber-800">
            This lead has no email on file
            {lead.instagram_handle ? (
              <>
                . Reach out via{" "}
                <a
                  href={`https://www.instagram.com/${lead.instagram_handle}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Instagram DM
                </a>{" "}
                instead, then update the lead with the real email so future
                templates can fire.
              </>
            ) : (
              ". Add an email or instagram_handle before sending."
            )}
          </p>
        ) : templates.length === 0 ? (
          <p className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
            No published lead templates yet. Create one at{" "}
            <code>/admin/notifications/lead-templates/&lt;key&gt;</code> first.
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Template
            </label>
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {templates.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label} ({t.key})
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {result && (
          <p className="mt-3 rounded-md border border-emerald-300/40 bg-emerald-50 p-2 text-xs text-emerald-700">
            {result}
          </p>
        )}

        <footer className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending || !picked || templates.length === 0 || !lead.email}
            className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface ImportDrawerProps {
  onClose: () => void;
  onComplete: () => void;
}

function ImportDrawer({ onClose, onComplete }: ImportDrawerProps) {
  const [pasted, setPasted] = useState<string>("");
  const [source, setSource] = useState<string>("manual-paste");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const rows = parseRows(pasted);
      const res = await fetch("/api/admin/leads/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, rows }),
      });
      if (!res.ok) {
        const e = (await res.json()) as { error?: string };
        throw new Error(e.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ImportSummary;
      setSummary(data);
      if (data.failed === 0) {
        // Brief delay so user sees the result, then close.
        setTimeout(onComplete, 800);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-medium">Import leads</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Close
        </button>
      </header>
      <p className="mb-3 text-xs text-muted-foreground">
        Paste CSV (one row per line, header optional but recommended) OR JSON
        array. Recognised columns:{" "}
        <code className="font-mono">
          email, instagram_handle, phone, name, company, location, category,
          has_website, website_url, biography, tags, source, status, notes,
          owner
        </code>
        . Each row needs at least one of <code>email</code> /{" "}
        <code>instagram_handle</code> / <code>phone</code>. Comma-separated
        values inside <code>category</code> / <code>tags</code> become arrays
        (quote the cell so the CSV parser doesn&apos;t split on them).
      </p>
      <div className="grid gap-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="src">
            Source label
          </label>
          <input
            id="src"
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            placeholder="manual-paste / typeform-2026-04 / instagram_outreach …"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="rows">
            Rows
          </label>
          <textarea
            id="rows"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={10}
            className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs"
            placeholder='instagram_handle,name,location,category,has_website
urbanazhagi.store,Urbanazhagi,Chennai,"Kurtis, Dupattas",no'
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !pasted.trim()}
            className="inline-flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            {submitting ? "Importing…" : "Import"}
          </button>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>
        {summary ? (
          <div className="rounded-md border border-border bg-background p-3 text-xs">
            <div>
              {summary.total} processed · {summary.inserted} new ·{" "}
              {summary.updated} updated · {summary.failed} failed
            </div>
            {summary.failed > 0 ? (
              <ul className="mt-2 space-y-1 text-destructive">
                {summary.errors.slice(0, 10).map((e) => (
                  <li key={e.row}>
                    row {e.row + 1} ({e.email ?? e.instagram_handle ?? "?"}):{" "}
                    {e.error}
                  </li>
                ))}
                {summary.errors.length > 10 ? (
                  <li>+{summary.errors.length - 10} more</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface ParsedRow {
  email?: string;
  instagram_handle?: string;
  phone?: string;
  name?: string;
  company?: string;
  location?: string;
  category?: string[];
  has_website?: boolean | null;
  website_url?: string;
  biography?: string;
  tags?: string[];
  source?: string;
  status?: string;
  notes?: string;
  owner?: string;
}

const ARRAY_COLS = new Set(["category", "tags"]);
const BOOL_COLS = new Set(["has_website"]);

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "unknown" || v === "?") return null;
  if (["true", "yes", "y", "1", "has"].includes(v)) return true;
  if (["false", "no", "n", "0", "none"].includes(v)) return false;
  return null;
}

function parseArray(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Parse pasted text — JSON array first, fall back to CSV.
function parseRows(input: string): ParsedRow[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // JSON array path.
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as ParsedRow[];
    if (!Array.isArray(parsed)) {
      throw new Error("expected JSON array of objects");
    }
    return parsed;
  }

  // CSV path. Header is the first non-empty line.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV needs a header row + at least one data row");
  }
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const out: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, unknown> = {};
    header.forEach((h, j) => {
      const v = (cells[j] ?? "").trim();
      if (v.length === 0) return;
      if (ARRAY_COLS.has(h)) {
        row[h] = parseArray(v);
      } else if (BOOL_COLS.has(h)) {
        row[h] = parseBool(v);
      } else {
        row[h] = v;
      }
    });
    if (!row.email && !row.instagram_handle && !row.phone) {
      throw new Error(
        `row ${i + 1} needs at least one of email / instagram_handle / phone`,
      );
    }
    out.push(row as ParsedRow);
  }
  return out;
}

// Minimal CSV splitter that handles quoted fields.
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells;
}
