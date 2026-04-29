"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  HardDrive,
  RefreshCw,
  Loader2,
  Folder,
  File,
  ChevronRight,
  Search,
  Info,
  Home,
} from "lucide-react";
import { AdminHeader } from "@/components/admin/header";
import {
  Badge,
  Button,
  Card,
  CardContent,
  ErrorState,
  Input,
  Skeleton,
} from "@tesserix/web";
import { apiFetch } from "@/lib/api/use-api";

// ─── Types ───

interface StorageFolder {
  type: "folder";
  name: string;
  displayName: string;
}

interface StorageFile {
  type: "file";
  name: string;
  displayName: string;
  size: number;
  contentType: string;
  updated: string;
  timeCreated: string;
  storageClass: string;
}

type StorageItem = StorageFolder | StorageFile;

interface StorageData {
  bucket: string;
  prefix: string;
  folders: StorageFolder[];
  files: StorageFile[];
  nextPageToken?: string;
  totalObjects: number;
  error?: string;
  message?: string;
  setupSteps?: string[];
}

// ─── Helpers ───

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

// ─── Breadcrumbs ───

function Breadcrumbs({
  prefix,
  bucket,
  onNavigate,
}: {
  prefix: string;
  bucket: string;
  onNavigate: (prefix: string) => void;
}) {
  const parts = prefix ? prefix.split("/").filter(Boolean) : [];

  return (
    <div className="flex items-center gap-1 text-sm flex-wrap">
      <button
        onClick={() => onNavigate("")}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
      >
        <Home className="h-3.5 w-3.5" />
        <span className="font-mono">{bucket}</span>
      </button>
      {parts.map((part, i) => {
        const pathUpTo = parts.slice(0, i + 1).join("/") + "/";
        const isLast = i === parts.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            {isLast ? (
              <span className="font-mono font-medium text-foreground">{part}</span>
            ) : (
              <button
                onClick={() => onNavigate(pathUpTo)}
                className="font-mono text-muted-foreground hover:text-foreground transition-colors"
              >
                {part}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ─── Setup Card ───

function SetupCard({ message, steps }: { message: string; steps: string[] }) {
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Setup required</p>
            <p className="text-xs text-muted-foreground">{message}</p>
            <ol className="space-y-1">
              {steps.map((step, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-xs text-warning"
                >
                  <span className="shrink-0 font-semibold">{i + 1}.</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───

export default function StoragePage() {
  const [prefix, setPrefix] = useState("");
  const [data, setData] = useState<StorageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const fetchObjects = useCallback(
    async (currentPrefix: string, append = false) => {
      if (!append) setLoading(true);
      else setLoadingMore(true);
      setError(null);

      const params = new URLSearchParams({ prefix: currentPrefix });
      if (append && data?.nextPageToken) {
        params.set("pageToken", data.nextPageToken);
      }

      const res = await apiFetch<StorageData>(`/api/storage?${params.toString()}`);
      if (res.error) {
        setError(res.error);
      } else if (res.data) {
        if (append && data) {
          setData({
            ...res.data,
            folders: [...data.folders, ...res.data.folders],
            files: [...data.files, ...res.data.files],
          });
        } else {
          setData(res.data);
        }
      }

      if (!append) setLoading(false);
      else setLoadingMore(false);
    },
    [data]
  );

  useEffect(() => {
    fetchObjects(prefix, false);
     
  }, [prefix]);

  const navigate = (newPrefix: string) => {
    setSearch("");
    setPrefix(newPrefix);
  };

  const allItems: StorageItem[] = useMemo(() => {
    if (!data) return [];
    const items: StorageItem[] = [
      ...data.folders,
      ...data.files,
    ];
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter((item) =>
      item.displayName.toLowerCase().includes(q)
    );
  }, [data, search]);

  const totalSize = useMemo(
    () => data?.files.reduce((sum, f) => sum + f.size, 0) ?? 0,
    [data]
  );

  return (
    <>
      <AdminHeader
        title="GCS Storage"
        description="Browse objects in the GCS bucket"
        icon={HardDrive}
      />

      <main className="p-6 space-y-6">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {data?.bucket && (
          <Breadcrumbs
            prefix={prefix}
            bucket={data.bucket}
            onNavigate={navigate}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9 w-48"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchObjects(prefix, false)}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span className="ml-1">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Summary */}
      {!loading && data && !data.error && (
        <div className="flex items-center gap-4 mb-3 text-sm text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{data.folders.length}</span> folders
          </span>
          <span>
            <span className="font-medium text-foreground">{data.files.length}</span> files
          </span>
          <span>
            <span className="font-medium text-foreground">{formatBytes(totalSize)}</span> total
          </span>
        </div>
      )}

      {/* Error */}
      {error && (
        <ErrorState message={error} onRetry={() => fetchObjects(prefix, false)} />
      )}

      {/* Setup required */}
      {!loading && data?.error && data.message && (
        <SetupCard
          message={data.message}
          steps={data.setupSteps ?? []}
        />
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-1.5">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      )}

      {/* File listing */}
      {!loading && allItems.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {allItems.map((item) => {
                if (item.type === "folder") {
                  return (
                    <button
                      key={item.name}
                      onClick={() => navigate(item.name)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                    >
                      <Folder className="h-4 w-4 text-warning shrink-0" />
                      <span className="flex-1 font-mono text-sm font-medium">
                        {item.displayName}/
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  );
                }

                // File
                return (
                  <div
                    key={item.name}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors"
                  >
                    <File className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <div className="flex-1 min-w-0">
                      <p className="font-mono text-sm truncate">{item.displayName}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {item.contentType}
                      </p>
                    </div>
                    <div className="text-right shrink-0 space-y-0.5">
                      <p className="text-sm font-medium">{formatBytes(item.size)}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(item.updated)}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {item.storageClass}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!loading && !error && allItems.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <HardDrive className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">
              {search ? "No files match your search" : "This folder is empty"}
            </p>
            {search && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => setSearch("")}
              >
                Clear search
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Load more */}
      {!loading && data?.nextPageToken && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchObjects(prefix, true)}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : null}
            Load more
          </Button>
        </div>
      )}
      </main>
    </>
  );
}
