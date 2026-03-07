"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Database,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  HardDrive,
  Users,
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  ServerCrash,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";

// ─── Types ───

interface SqlDatabase {
  name: string;
  charset?: string;
}

interface SqlIpAddress {
  address: string;
  type: string;
}

interface SqlInstance {
  name: string;
  databaseVersion: string;
  state: string;
  region: string;
  tier: string;
  storageGb: number | null;
  storageAutoResize: boolean;
  backupEnabled: boolean;
  availabilityType: string;
  ipAddresses: SqlIpAddress[];
  databases: SqlDatabase[];
}

interface SqlUser {
  name: string;
  host: string;
  type: string;
}

// ─── Helpers ───

function stateBadge(state: string) {
  const s = state.toUpperCase();
  if (s === "RUNNABLE") {
    return (
      <Badge className="gap-1 bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20 hover:bg-green-500/10">
        <CheckCircle2 className="h-3 w-3" />
        Running
      </Badge>
    );
  }
  if (s === "STOPPED" || s === "SUSPENDED") {
    return (
      <Badge className="gap-1 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20 hover:bg-yellow-500/10">
        <XCircle className="h-3 w-3" />
        {state}
      </Badge>
    );
  }
  if (s === "FAILED") {
    return (
      <Badge className="gap-1 bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20 hover:bg-red-500/10">
        <ServerCrash className="h-3 w-3" />
        Failed
      </Badge>
    );
  }
  return <Badge variant="secondary">{state}</Badge>;
}

function versionLabel(ver: string): string {
  // e.g. POSTGRES_15 → PostgreSQL 15
  return ver
    .replace("POSTGRES_", "PostgreSQL ")
    .replace("MYSQL_", "MySQL ")
    .replace("SQLSERVER_", "SQL Server ");
}

function availabilityLabel(type: string): string {
  return type === "REGIONAL" ? "HA (Regional)" : "Zonal";
}

// ─── Users Section ───

function UsersSection({ instanceName }: { instanceName: string }) {
  const [users, setUsers] = useState<SqlUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (loaded) return;
    setLoading(true);
    const res = await apiFetch<{ data: SqlUser[] }>(
      `/api/cloud-sql/users?instance=${encodeURIComponent(instanceName)}`
    );
    if (res.data?.data) setUsers(res.data.data);
    setLoading(false);
    setLoaded(true);
  }, [instanceName, loaded]);

  const handleToggle = () => {
    if (!open && !loaded) load();
    setOpen((v) => !v);
  };

  return (
    <div>
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Users className="h-3.5 w-3.5" />
        DB Users
        {loaded && (
          <Badge variant="secondary" className="text-xs ml-1">
            {users.length}
          </Badge>
        )}
      </button>

      {open && (
        <div className="mt-2 ml-5">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading users...
            </div>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground">No users found</p>
          ) : (
            <div className="space-y-1">
              {users.map((u) => (
                <div key={u.name} className="flex items-center gap-2">
                  <code className="text-xs font-mono bg-muted/60 rounded px-1.5 py-0.5">
                    {u.name}
                  </code>
                  <span className="text-xs text-muted-foreground">{u.host}</span>
                  {u.type === "CLOUD_IAM_USER" && (
                    <Badge variant="outline" className="text-xs py-0">
                      IAM
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Instance Card ───

function InstanceCard({ inst }: { inst: SqlInstance }) {
  const [dbsOpen, setDbsOpen] = useState(true);

  const primaryIp = inst.ipAddresses.find((ip) => ip.type === "PRIMARY")?.address;

  return (
    <Card>
      {/* Header */}
      <div className="flex items-start justify-between p-4 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="rounded-md bg-blue-500/10 p-1.5">
            <Database className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h3 className="font-semibold text-sm font-mono">{inst.name}</h3>
            <p className="text-xs text-muted-foreground">{versionLabel(inst.databaseVersion)}</p>
          </div>
        </div>
        {stateBadge(inst.state)}
      </div>

      <CardContent className="pt-0 px-4 pb-4 space-y-4">
        {/* Meta grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground mb-0.5">Tier</p>
            <p className="text-sm font-medium font-mono">{inst.tier}</p>
          </div>
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground mb-0.5">Region</p>
            <p className="text-sm font-medium">{inst.region}</p>
          </div>
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground mb-0.5">Storage</p>
            <p className="text-sm font-medium">
              {inst.storageGb !== null ? `${inst.storageGb} GB` : "—"}
              {inst.storageAutoResize && (
                <span className="text-xs text-muted-foreground ml-1">(auto)</span>
              )}
            </p>
          </div>
          <div className="rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground mb-0.5">Availability</p>
            <p className="text-sm font-medium">{availabilityLabel(inst.availabilityType)}</p>
          </div>
        </div>

        {/* Status flags */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            {inst.backupEnabled ? (
              <Shield className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Shield className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className={inst.backupEnabled ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>
              {inst.backupEnabled ? "Backups enabled" : "Backups disabled"}
            </span>
          </div>
          {primaryIp && (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <HardDrive className="h-3.5 w-3.5" />
              <code className="font-mono">{primaryIp}</code>
            </div>
          )}
        </div>

        {/* Databases */}
        {inst.databases.length > 0 && (
          <div>
            <button
              onClick={() => setDbsOpen((v) => !v)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors mb-2"
            >
              {dbsOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <Database className="h-3.5 w-3.5" />
              Databases
              <Badge variant="secondary" className="text-xs ml-1">
                {inst.databases.length}
              </Badge>
            </button>
            {dbsOpen && (
              <div className="ml-5 flex flex-wrap gap-1.5">
                {inst.databases.map((db) => (
                  <code
                    key={db.name}
                    className="text-xs font-mono bg-muted/60 rounded px-2 py-0.5 border border-border/50"
                  >
                    {db.name}
                  </code>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Users (load on demand) */}
        <UsersSection instanceName={inst.name} />
      </CardContent>
    </Card>
  );
}

// ─── Summary Bar ───

function SummaryBar({ instances }: { instances: SqlInstance[] }) {
  const totalDbs = instances.reduce((sum, i) => sum + i.databases.length, 0);
  const backupsOn = instances.filter((i) => i.backupEnabled).length;

  const stats = [
    { label: "Instances", value: instances.length },
    { label: "Databases", value: totalDbs },
    {
      label: "Backups",
      value: `${backupsOn}/${instances.length}`,
      good: backupsOn === instances.length,
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map((s) => (
        <Card key={s.label}>
          <CardContent className="p-3 text-center">
            <p
              className={`text-2xl font-bold ${
                "good" in s && s.good === false ? "text-yellow-600 dark:text-yellow-400" : ""
              }`}
            >
              {s.value}
            </p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Main Page ───

export default function CloudSqlPage() {
  const [instances, setInstances] = useState<SqlInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchInstances = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<{ data: SqlInstance[] }>("/api/cloud-sql");
    if (res.error) {
      setError(res.error);
    } else if (res.data?.data) {
      setInstances(res.data.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  return (
    <>
      <AdminHeader
        title="Cloud SQL"
        description="Managed PostgreSQL instances — db-f1-micro with per-service databases"
        icon={Database}
      />

      <div className="space-y-4">
        {/* Toolbar */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            GCP project: <code className="font-mono text-xs">tesserix</code> &middot; region:{" "}
            <code className="font-mono text-xs">us-central1</code>
          </p>
          <Button variant="outline" size="sm" onClick={fetchInstances} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Loading skeletons */}
        {loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20" />
              ))}
            </div>
            <Skeleton className="h-64" />
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <Card className="border-destructive/40">
            <CardContent className="p-6 text-center space-y-2">
              <ServerCrash className="h-8 w-8 text-destructive mx-auto" />
              <p className="text-sm font-medium text-destructive">Failed to load instances</p>
              <p className="text-xs text-muted-foreground font-mono">{error}</p>
              <Button variant="outline" size="sm" onClick={fetchInstances}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Content */}
        {!loading && !error && (
          <>
            <SummaryBar instances={instances} />

            {instances.length === 0 ? (
              <Card>
                <CardContent className="p-8 text-center text-sm text-muted-foreground">
                  No Cloud SQL instances found in this project.
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {instances.map((inst) => (
                  <InstanceCard key={inst.name} inst={inst} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
