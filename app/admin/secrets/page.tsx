"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  KeyRound,
  Github,
  Cloud,
  Search,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  RefreshCw,
  Pencil,
  Copy,
  Check,
  Loader2,
  Map,
  Filter,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Skeleton,
  Stat,
  StatLabel,
  StatValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";
import {
  SERVICE_REGISTRY,
  type AppGroup,
} from "@/lib/releases/services";

// ─── Types ───

interface GHRepoSecrets {
  repo: string;
  repoShort: string;
  secrets: Array<{ name: string; createdAt: string; updatedAt: string }>;
}

interface GCPSecret {
  name: string;
  fullName: string;
  createdAt: string;
  labels: Record<string, string>;
}

const APP_GROUP_LABELS: Record<"all" | AppGroup, string> = {
  all: "All",
  platform: "Platform",
  mark8ly: "Mark8ly",
};

function getAppGroupForRepo(repoShort: string): AppGroup {
  const svc = SERVICE_REGISTRY.find((s) => s.name === repoShort);
  return svc?.appGroup ?? "platform";
}

// ─── AppGroup Filter ───

function AppGroupFilter({
  value,
  onChange,
}: {
  value: "all" | AppGroup;
  onChange: (v: "all" | AppGroup) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border p-0.5">
      {(Object.keys(APP_GROUP_LABELS) as Array<"all" | AppGroup>).map((key) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === key
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {APP_GROUP_LABELS[key]}
        </button>
      ))}
    </div>
  );
}

// ─── GitHub Secrets Tab ───

function GitHubSecretsTab() {
  const [data, setData] = useState<GHRepoSecrets[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [appGroup, setAppGroup] = useState<"all" | AppGroup>("all");
  const [editingSecret, setEditingSecret] = useState<{
    repo: string;
    name: string;
    isNew: boolean;
  } | null>(null);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchSecrets = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch<{ data: GHRepoSecrets[] }>("/api/secrets");
    if (res.data?.data) setData(res.data.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  const handleSave = async () => {
    if (!editingSecret || !secretName || !secretValue) return;
    setSaving(true);
    const res = await apiFetch("/api/secrets/update", {
      method: "POST",
      body: JSON.stringify({
        repo: editingSecret.repo,
        name: secretName,
        value: secretValue,
      }),
    });
    setSaving(false);
    if (!res.error) {
      setEditingSecret(null);
      setSecretName("");
      setSecretValue("");
      fetchSecrets();
    }
  };

  const handleDelete = async (repo: string, name: string) => {
    if (!confirm(`Delete secret ${name} from ${repo}?`)) return;
    setDeleting(`${repo}:${name}`);
    await apiFetch("/api/secrets/update", {
      method: "DELETE",
      body: JSON.stringify({ repo, name }),
    });
    setDeleting(null);
    fetchSecrets();
  };

  const filtered = data
    .filter((r) => {
      if (appGroup !== "all" && getAppGroupForRepo(r.repoShort) !== appGroup) return false;
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        r.repoShort.toLowerCase().includes(q) ||
        r.secrets.some((s) => s.name.toLowerCase().includes(q))
      );
    });

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search repos or secrets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <AppGroupFilter value={appGroup} onChange={setAppGroup} />
        <Button variant="outline" size="sm" onClick={fetchSecrets}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
      </div>

      <div className="text-sm text-muted-foreground">
        {filtered.reduce((sum, r) => sum + r.secrets.length, 0)} secrets across{" "}
        {filtered.length} repos
      </div>

      {/* Edit/Create dialog */}
      {editingSecret && (
        <Card className="border-primary/30">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {editingSecret.isNew ? "Add Secret to" : "Update Secret in"}{" "}
                <span className="font-mono">{editingSecret.repo.split("/")[1]}</span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingSecret(null)}
              >
                Cancel
              </Button>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="SECRET_NAME"
                value={secretName}
                onChange={(e) => setSecretName(e.target.value.toUpperCase())}
                className="font-mono h-9 flex-1"
                disabled={!editingSecret.isNew}
              />
              <Input
                placeholder="Secret value"
                type="password"
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                className="font-mono h-9 flex-1"
              />
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!secretName || !secretValue || saving}
                className="h-9"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {filtered.map((repo) => (
        <Card key={repo.repo}>
          <div className="flex items-center justify-between p-4 pb-2">
            <div className="flex items-center gap-2">
              <Github className="h-4 w-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">{repo.repoShort}</h4>
              <Badge variant="secondary" className="text-xs">
                {repo.secrets.length}
              </Badge>
              <Badge variant="outline" className="text-xs">
                {getAppGroupForRepo(repo.repoShort)}
              </Badge>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setEditingSecret({
                  repo: repo.repo,
                  name: "",
                  isNew: true,
                });
                setSecretName("");
                setSecretValue("");
              }}
            >
              <Plus className="h-3 w-3 mr-1" />
              Add
            </Button>
          </div>
          <CardContent className="pt-0 pb-3 px-4">
            <div className="divide-y">
              {repo.secrets.map((secret) => (
                <div
                  key={secret.name}
                  className="flex items-center justify-between py-2"
                >
                  <div>
                    <p className="font-mono text-sm">{secret.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Updated{" "}
                      {new Date(secret.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => {
                        setEditingSecret({
                          repo: repo.repo,
                          name: secret.name,
                          isNew: false,
                        });
                        setSecretName(secret.name);
                        setSecretValue("");
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(repo.repo, secret.name)}
                      disabled={deleting === `${repo.repo}:${secret.name}`}
                    >
                      {deleting === `${repo.repo}:${secret.name}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
              {repo.secrets.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">
                  No secrets configured
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── GCP Secrets Tab ───

function GCPSecretsTab() {
  const [secrets, setSecrets] = useState<GCPSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [revealedSecret, setRevealedSecret] = useState<{
    name: string;
    value: string;
  } | null>(null);
  const [revealing, setRevealing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<{
    name: string;
    isNew: boolean;
  } | null>(null);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchSecrets = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch<{ data: GCPSecret[] }>("/api/secrets/gcp");
    if (res.data?.data) setSecrets(res.data.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  const handleReveal = async (name: string) => {
    if (revealedSecret?.name === name) {
      setRevealedSecret(null);
      return;
    }
    setRevealing(name);
    const res = await apiFetch<{ data: { name: string; value: string } }>(
      `/api/secrets/gcp?name=${encodeURIComponent(name)}`
    );
    if (res.data?.data) {
      setRevealedSecret(res.data.data);
    }
    setRevealing(null);
  };

  const handleCopy = (value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSave = async () => {
    if (!editName || !editValue) return;
    setSaving(true);
    const res = await apiFetch("/api/secrets/gcp", {
      method: "POST",
      body: JSON.stringify({ name: editName, value: editValue }),
    });
    setSaving(false);
    if (!res.error) {
      setEditing(null);
      setEditName("");
      setEditValue("");
      fetchSecrets();
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete GCP secret "${name}"? This cannot be undone.`)) return;
    setDeleting(name);
    await apiFetch("/api/secrets/gcp", {
      method: "DELETE",
      body: JSON.stringify({ name }),
    });
    setDeleting(null);
    if (revealedSecret?.name === name) setRevealedSecret(null);
    fetchSecrets();
  };

  const filtered = secrets.filter(
    (s) => !search || s.name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search secrets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button variant="outline" size="sm" onClick={fetchSecrets}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setEditing({ name: "", isNew: true });
            setEditName("");
            setEditValue("");
          }}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add Secret
        </Button>
      </div>

      <div className="text-sm text-muted-foreground">
        {secrets.length} secrets in GCP Secret Manager
      </div>

      {/* Edit/Create dialog */}
      {editing && (
        <Card className="border-primary/30">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">
                {editing.isNew ? "Create Secret" : `Update "${editing.name}"`}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
            <div className="flex gap-2">
              {editing.isNew && (
                <Input
                  placeholder="secret-name"
                  value={editName}
                  onChange={(e) =>
                    setEditName(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, "-"))
                  }
                  className="font-mono h-9 flex-1"
                />
              )}
              <Input
                placeholder="Secret value"
                type="password"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                className="font-mono h-9 flex-1"
              />
              <Button
                size="sm"
                onClick={handleSave}
                disabled={
                  (editing.isNew && !editName) || !editValue || saving
                }
                className="h-9"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="divide-y">
            {filtered.map((secret) => (
              <div key={secret.name} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-mono text-sm font-medium">
                      {secret.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Created{" "}
                      {new Date(secret.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => handleReveal(secret.name)}
                      disabled={revealing === secret.name}
                    >
                      {revealing === secret.name ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : revealedSecret?.name === secret.name ? (
                        <EyeOff className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0"
                      onClick={() => {
                        setEditing({ name: secret.name, isNew: false });
                        setEditName(secret.name);
                        setEditValue("");
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(secret.name)}
                      disabled={deleting === secret.name}
                    >
                      {deleting === secret.name ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                </div>
                {revealedSecret?.name === secret.name && (
                  <div className="mt-2 flex items-center gap-2 rounded bg-muted/50 p-2">
                    <code className="text-xs font-mono flex-1 break-all">
                      {revealedSecret.value}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0"
                      onClick={() => handleCopy(revealedSecret.value)}
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
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No secrets found
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Dependency Map Tab ───

function DependencyMapTab() {
  const [data, setData] = useState<GHRepoSecrets[]>([]);
  const [loading, setLoading] = useState(true);
  const [appGroup, setAppGroup] = useState<"all" | AppGroup>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"by-secret" | "matrix">("by-secret");

  const fetchSecrets = useCallback(async () => {
    setLoading(true);
    const res = await apiFetch<{ data: GHRepoSecrets[] }>("/api/secrets");
    if (res.data?.data) setData(res.data.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSecrets();
  }, [fetchSecrets]);

  const filteredRepos = useMemo(
    () =>
      data.filter(
        (r) => appGroup === "all" || getAppGroupForRepo(r.repoShort) === appGroup
      ),
    [data, appGroup]
  );

  // Build secret → repos map
  const secretToRepos = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const repo of filteredRepos) {
      for (const s of repo.secrets) {
        const list = map[s.name] || [];
        list.push(repo.repoShort);
        map[s.name] = list;
      }
    }
    return map;
  }, [filteredRepos]);

  // All unique secrets sorted
  const allSecrets = useMemo(() => {
    const names = Object.keys(secretToRepos).sort();
    if (!search) return names;
    const q = search.toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(q));
  }, [secretToRepos, search]);

  // Repos for matrix columns
  const repoNames = useMemo(
    () => filteredRepos.map((r) => r.repoShort).sort(),
    [filteredRepos]
  );

  // Repo secret sets for fast lookup
  const repoSecretSets = useMemo(() => {
    const map: Record<string, Set<string>> = {};
    for (const repo of filteredRepos) {
      map[repo.repoShort] = new Set(repo.secrets.map((s: { name: string }) => s.name));
    }
    return map;
  }, [filteredRepos]);

  // Shared secrets (in 2+ repos)
  const sharedSecrets = useMemo(
    () => allSecrets.filter((s) => (secretToRepos[s]?.length ?? 0) > 1),
    [allSecrets, secretToRepos]
  );

  // Unique secrets (only in 1 repo)
  const uniqueSecrets = useMemo(
    () => allSecrets.filter((s) => (secretToRepos[s]?.length ?? 0) === 1),
    [allSecrets, secretToRepos]
  );

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-xs min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search secrets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <AppGroupFilter value={appGroup} onChange={setAppGroup} />
        <div className="flex items-center gap-1 rounded-lg border p-0.5">
          <button
            onClick={() => setView("by-secret")}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              view === "by-secret"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            By Secret
          </button>
          <button
            onClick={() => setView("matrix")}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              view === "matrix"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Matrix
          </button>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSecrets}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Stat size="sm" className="text-center">
          <StatValue>{allSecrets.length}</StatValue>
          <StatLabel>Unique Secrets</StatLabel>
        </Stat>
        <Stat size="sm" className="text-center">
          <StatValue>{sharedSecrets.length}</StatValue>
          <StatLabel>Shared Across Repos</StatLabel>
        </Stat>
        <Stat size="sm" className="text-center">
          <StatValue>{filteredRepos.length}</StatValue>
          <StatLabel>Repos</StatLabel>
        </Stat>
      </div>

      {view === "by-secret" ? (
        <div className="space-y-3">
          {/* Shared secrets */}
          {sharedSecrets.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                Shared Secrets
                <Badge variant="secondary" className="text-xs">{sharedSecrets.length}</Badge>
              </h3>
              <Card>
                <CardContent className="p-0 divide-y">
                  {sharedSecrets.map((name) => {
                    const repos = secretToRepos[name] || [];
                    return (
                      <div key={name} className="px-4 py-3">
                        <div className="flex items-center justify-between">
                          <p className="font-mono text-sm font-medium">{name}</p>
                          <Badge variant="outline" className="text-xs">
                            {repos.length} repos
                          </Badge>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {repos.map((r) => (
                            <Badge key={r} variant="secondary" className="text-xs font-mono">
                              {r}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Unique secrets */}
          {uniqueSecrets.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                Repo-Specific Secrets
                <Badge variant="secondary" className="text-xs">{uniqueSecrets.length}</Badge>
              </h3>
              <Card>
                <CardContent className="p-0 divide-y">
                  {uniqueSecrets.map((name) => {
                    const repos = secretToRepos[name] || [];
                    return (
                      <div key={name} className="flex items-center justify-between px-4 py-2.5">
                        <p className="font-mono text-sm">{name}</p>
                        <Badge variant="secondary" className="text-xs font-mono">
                          {repos[0]}
                        </Badge>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      ) : (
        /* Matrix view */
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="sticky left-0 bg-card px-3 py-2 text-left font-semibold min-w-[180px]">
                      Secret
                    </th>
                    {repoNames.map((repo) => (
                      <th
                        key={repo}
                        className="px-2 py-2 text-center font-medium"
                      >
                        <div className="writing-mode-vertical -rotate-45 origin-bottom-left whitespace-nowrap translate-x-2 mb-1 h-[80px] flex items-end">
                          {repo}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allSecrets.map((secret) => (
                    <tr key={secret} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="sticky left-0 bg-card px-3 py-1.5 font-mono font-medium">
                        {secret}
                      </td>
                      {repoNames.map((repo) => {
                        const has = repoSecretSets[repo]?.has(secret);
                        return (
                          <td key={repo} className="px-2 py-1.5 text-center">
                            {has ? (
                              <span className="inline-block h-3 w-3 rounded-full bg-primary" />
                            ) : (
                              <span className="inline-block h-3 w-3 rounded-full bg-muted" />
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Main Page ───

export default function SecretsPage() {
  return (
    <>
      <AdminHeader
        title="Secrets"
        description="Manage GitHub Actions secrets and GCP Secret Manager"
        icon={KeyRound}
      />

      <main className="p-6 space-y-6">      <Tabs defaultValue="github" className="space-y-4">
        <TabsList>
          <TabsTrigger value="github" className="gap-2">
            <Github className="h-4 w-4" />
            GitHub Actions
          </TabsTrigger>
          <TabsTrigger value="gcp" className="gap-2">
            <Cloud className="h-4 w-4" />
            GCP Secret Manager
          </TabsTrigger>
          <TabsTrigger value="map" className="gap-2">
            <Map className="h-4 w-4" />
            Dependency Map
          </TabsTrigger>
        </TabsList>
        <TabsContent value="github">
          <GitHubSecretsTab />
        </TabsContent>
        <TabsContent value="gcp">
          <GCPSecretsTab />
        </TabsContent>
        <TabsContent value="map">
          <DependencyMapTab />
        </TabsContent>
      </Tabs>
      </main>
    </>
  );
}
