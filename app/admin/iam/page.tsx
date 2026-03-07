"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Shield,
  Search,
  RefreshCw,
  Loader2,
  UserCog,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Skeleton,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";
import type { IamOverviewResponse, ServiceAccountEntry } from "@/app/api/iam/route";

// ─── Constants ───

/**
 * Roles that are considered overprivileged (broad project-level access).
 * These are highlighted in red.
 */
const OVERPRIVILEGED_ROLES = new Set([
  "roles/owner",
  "roles/editor",
  "roles/viewer",
  "roles/iam.admin",
  "roles/iam.securityAdmin",
]);

/**
 * Maps SA name prefix → the Cloud Run service it corresponds to.
 */
const SA_SERVICE_MAP: Record<string, string> = {
  "sa-auth-bff": "auth-bff",
  "sa-audit-service": "audit-service",
  "sa-tickets-service": "tickets-service",
  "sa-subscription-service": "subscription-service",
  "sa-tesserix-home": "tesserix-home",
  "sa-notifications": "notifications-service",
};

function getLinkedService(email: string): string | undefined {
  const prefix = email.split("@")[0];
  return SA_SERVICE_MAP[prefix];
}

function isOverprivileged(role: string): boolean {
  return OVERPRIVILEGED_ROLES.has(role);
}

function roleBadgeClass(role: string): string {
  if (isOverprivileged(role)) {
    return "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400 dark:border-red-900";
  }
  return "bg-green-100 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-400 dark:border-green-900";
}

function shortRole(role: string): string {
  // "roles/run.invoker" → "run.invoker"
  return role.startsWith("roles/") ? role.slice(6) : role;
}

// ─── Summary Cards ───

interface SummaryCardsProps {
  serviceAccounts: ServiceAccountEntry[];
  totalRoles: number;
}

function SummaryCards({ serviceAccounts, totalRoles }: SummaryCardsProps) {
  const disabled = serviceAccounts.filter((sa) => sa.disabled).length;
  const overprivilegedCount = serviceAccounts.filter((sa) =>
    sa.roles.some(isOverprivileged)
  ).length;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card>
        <CardContent className="p-4">
          <p className="text-2xl font-bold">{serviceAccounts.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Service Accounts</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <p className="text-2xl font-bold">{totalRoles}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Unique Roles</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <p className="text-2xl font-bold text-red-600">{overprivilegedCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Overprivileged</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          <p className="text-2xl font-bold text-muted-foreground">{disabled}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Disabled</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Service Account Card ───

function ServiceAccountCard({ sa }: { sa: ServiceAccountEntry }) {
  const linkedService = getLinkedService(sa.email);
  const hasOverprivilegedRole = sa.roles.some(isOverprivileged);

  return (
    <Card className={hasOverprivilegedRole ? "border-red-200 dark:border-red-900" : ""}>
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <UserCog className="h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="font-mono text-sm font-medium break-all">
                {sa.email}
              </p>
            </div>
            {sa.displayName && (
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                {sa.displayName}
              </p>
            )}
            {sa.description && (
              <p className="text-xs text-muted-foreground mt-0.5 ml-6">
                {sa.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {linkedService && (
              <Badge variant="outline" className="text-xs font-mono">
                {linkedService}
              </Badge>
            )}
            {sa.disabled ? (
              <Badge className="text-xs bg-muted text-muted-foreground border">
                Disabled
              </Badge>
            ) : (
              <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Active
              </span>
            )}
            {hasOverprivilegedRole && (
              <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                Overprivileged
              </span>
            )}
          </div>
        </div>

        {/* Roles */}
        <div>
          {sa.roles.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {sa.roles.map((role) => (
                <span
                  key={role}
                  className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium font-mono ${roleBadgeClass(role)}`}
                >
                  {shortRole(role)}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              No project-level roles assigned
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───

export default function IAMPage() {
  const [data, setData] = useState<IamOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<{ data: IamOverviewResponse }>("/api/iam");
    if (res.error) {
      setError(typeof res.error === "string" ? res.error : "Failed to fetch IAM data");
    } else if (res.data?.data) {
      setData(res.data.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search) return data.serviceAccounts;
    const q = search.toLowerCase();
    return data.serviceAccounts.filter(
      (sa) =>
        sa.email.toLowerCase().includes(q) ||
        sa.displayName.toLowerCase().includes(q) ||
        sa.roles.some((r) => r.toLowerCase().includes(q))
    );
  }, [data, search]);

  return (
    <>
      <AdminHeader
        title="IAM & Service Accounts"
        description="GCP project service accounts and their IAM role bindings"
        icon={<Shield className="h-5 w-5 text-muted-foreground" />}
      />

      <div className="p-6 space-y-6">
        {/* Summary */}
        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : data ? (
          <SummaryCards
            serviceAccounts={data.serviceAccounts}
            totalRoles={data.totalRoles}
          />
        ) : null}

        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-xs min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search accounts or roles..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            Refresh
          </Button>

          {data && !loading && (
            <p className="text-sm text-muted-foreground ml-auto">
              {filtered.length} of {data.serviceAccounts.length} accounts
            </p>
          )}
        </div>

        {/* Error */}
        {error && (
          <Card className="border-destructive/50">
            <CardContent className="p-4">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* List */}
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((sa) => (
              <ServiceAccountCard key={sa.email} sa={sa} />
            ))}
            {filtered.length === 0 && !error && (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    No service accounts found
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
