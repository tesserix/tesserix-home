"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Globe,
  Search,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  RefreshCw,
  Pencil,
  Check,
  Loader2,
  Copy,
  ServerCrash,
  X,
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

// ─── Types ───

interface KvKey {
  key: string;
  expiration: number | null;
}

type KeyFilter = "all" | "tenant" | "domain";

// ─── Helpers ───

function keyPrefix(key: string): "tenant" | "domain" | "other" {
  if (key.startsWith("tenant:")) return "tenant";
  if (key.startsWith("domain:")) return "domain";
  return "other";
}

function KeyBadge({ k }: { k: string }) {
  const prefix = keyPrefix(k);
  if (prefix === "tenant") {
    return (
      <Badge className="text-xs font-mono bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20 hover:bg-blue-500/10">
        {k}
      </Badge>
    );
  }
  if (prefix === "domain") {
    return (
      <Badge className="text-xs font-mono bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20 hover:bg-green-500/10">
        {k}
      </Badge>
    );
  }
  return (
    <code className="text-xs font-mono bg-muted/60 rounded px-1.5 py-0.5">{k}</code>
  );
}

// ─── Filter Buttons ───

const FILTERS: { value: KeyFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "tenant", label: "Tenant Routes" },
  { value: "domain", label: "Custom Domains" },
];

function FilterBar({
  value,
  onChange,
}: {
  value: KeyFilter;
  onChange: (v: KeyFilter) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border p-0.5">
      {FILTERS.map((f) => (
        <button
          key={f.value}
          onClick={() => onChange(f.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === f.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// ─── Edit Form (inline) ───

interface EditFormProps {
  initial?: { key: string; value: string };
  isNew: boolean;
  onSave: (key: string, value: string) => Promise<void>;
  onCancel: () => void;
}

function EditForm({ initial, isNew, onSave, onCancel }: EditFormProps) {
  const [key, setKey] = useState(initial?.key ?? "");
  const [value, setValue] = useState(initial?.value ?? "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!key || value === "") return;
    setSaving(true);
    await onSave(key, value);
    setSaving(false);
  };

  return (
    <Card className="border-primary/30">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{isNew ? "Add KV Entry" : `Edit "${initial?.key}"`}</p>
          <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 w-7 p-0">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {isNew && (
            <Input
              placeholder="key (e.g. tenant:acme or domain:acme.com)"
              value={key}
              onChange={(e) => setKey(e.target.value.trim())}
              className="font-mono h-9 flex-1"
            />
          )}
          <Input
            placeholder="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="font-mono h-9 flex-1"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!key || value === "" || saving}
            className="h-9 shrink-0"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── KV Row ───

interface KvRowProps {
  item: KvKey;
  onEdit: (key: string) => void;
  onDelete: (key: string) => void;
  deleting: boolean;
}

function KvRow({ item, onEdit, onDelete, deleting }: KvRowProps) {
  const [revealed, setRevealed] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleReveal = async () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (value !== null) {
      setRevealed(true);
      return;
    }
    setRevealing(true);
    const res = await apiFetch<{ data: { key: string; value: string } }>(
      `/api/cloudflare/kv?key=${encodeURIComponent(item.key)}`
    );
    if (res.data?.data?.value !== undefined) {
      setValue(res.data.data.value);
      setRevealed(true);
    }
    setRevealing(false);
  };

  const handleCopy = () => {
    if (value) {
      navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <KeyBadge k={item.key} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={handleReveal}
            disabled={revealing}
            title={revealed ? "Hide value" : "Reveal value"}
          >
            {revealing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : revealed ? (
              <EyeOff className="h-3 w-3" />
            ) : (
              <Eye className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onEdit(item.key)}
            title="Edit"
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(item.key)}
            disabled={deleting}
            title="Delete"
          >
            {deleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>

      {revealed && value !== null && (
        <div className="mt-2 flex items-center gap-2 rounded bg-muted/50 p-2">
          <code className="text-xs font-mono flex-1 break-all">{value}</code>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Summary Bar ───

function SummaryBar({ keys }: { keys: KvKey[] }) {
  const tenantCount = keys.filter((k) => keyPrefix(k.key) === "tenant").length;
  const domainCount = keys.filter((k) => keyPrefix(k.key) === "domain").length;

  const stats = [
    { label: "Total Keys", value: keys.length },
    { label: "Tenant Routes", value: tenantCount },
    { label: "Custom Domains", value: domainCount },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map((s) => (
        <Card key={s.label}>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold">{s.value}</p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Main Page ───

export default function CloudflareKvPage() {
  const [keys, setKeys] = useState<KvKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<KeyFilter>("all");
  const [editingKey, setEditingKey] = useState<string | null>(null); // key being edited
  const [addingNew, setAddingNew] = useState(false);
  const [editLoadedValue, setEditLoadedValue] = useState<string>("");
  const [editLoadingKey, setEditLoadingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<{ data: KvKey[] }>("/api/cloudflare/kv");
    if (res.error) {
      setError(res.error);
    } else if (res.data?.data) {
      setKeys(res.data.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const filtered = useMemo(() => {
    return keys.filter((k) => {
      if (filter === "tenant" && keyPrefix(k.key) !== "tenant") return false;
      if (filter === "domain" && keyPrefix(k.key) !== "domain") return false;
      if (search && !k.key.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [keys, filter, search]);

  const handleEdit = async (key: string) => {
    setEditLoadingKey(key);
    const res = await apiFetch<{ data: { key: string; value: string } }>(
      `/api/cloudflare/kv?key=${encodeURIComponent(key)}`
    );
    if (res.data?.data?.value !== undefined) {
      setEditLoadedValue(res.data.data.value);
    }
    setEditLoadingKey(null);
    setEditingKey(key);
    setAddingNew(false);
  };

  const handleSave = async (key: string, value: string) => {
    const res = await apiFetch("/api/cloudflare/kv", {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    });
    if (!res.error) {
      setEditingKey(null);
      setAddingNew(false);
      setEditLoadedValue("");
      fetchKeys();
    }
  };

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete KV key "${key}"? This cannot be undone.`)) return;
    setDeletingKey(key);
    await apiFetch("/api/cloudflare/kv", {
      method: "DELETE",
      body: JSON.stringify({ key }),
    });
    setDeletingKey(null);
    fetchKeys();
  };

  return (
    <>
      <AdminHeader
        title="Cloudflare KV"
        description="Tenant routing and custom domain mappings"
        icon={Globe}
      />

      <main className="p-6 space-y-6">
      <div className="space-y-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-xs min-w-[180px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search keys..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <FilterBar value={filter} onChange={setFilter} />
          <Button variant="outline" size="sm" onClick={fetchKeys} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setAddingNew(true);
              setEditingKey(null);
              setEditLoadedValue("");
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Entry
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
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <Card className="border-destructive/40">
            <CardContent className="p-6 text-center space-y-2">
              <ServerCrash className="h-8 w-8 text-destructive mx-auto" />
              <p className="text-sm font-medium text-destructive">Failed to load KV data</p>
              <p className="text-xs text-muted-foreground font-mono">{error}</p>
              <Button variant="outline" size="sm" onClick={fetchKeys}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {!loading && !error && (
          <>
            <SummaryBar keys={keys} />

            {/* Result count */}
            <p className="text-sm text-muted-foreground">
              {filtered.length} {filtered.length === 1 ? "key" : "keys"}
              {search && ` matching "${search}"`}
            </p>

            {/* Add new form */}
            {addingNew && (
              <EditForm
                isNew={true}
                onSave={handleSave}
                onCancel={() => setAddingNew(false)}
              />
            )}

            {/* Edit existing form */}
            {editingKey && (
              <EditForm
                isNew={false}
                initial={{ key: editingKey, value: editLoadedValue }}
                onSave={handleSave}
                onCancel={() => {
                  setEditingKey(null);
                  setEditLoadedValue("");
                }}
              />
            )}

            {/* Keys table */}
            <Card>
              <CardContent className="p-0">
                {filtered.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {keys.length === 0 ? "No KV keys found in this namespace." : "No keys match the current filter."}
                  </p>
                ) : (
                  <div className="divide-y">
                    {filtered.map((item) => (
                      <KvRow
                        key={item.key}
                        item={item}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        deleting={deletingKey === item.key || editLoadingKey === item.key}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
      </main>
    </>
  );
}
