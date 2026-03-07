"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Info,
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

interface TypeDefinition {
  type: string;
  relations: string[];
  rawRelations: Record<string, unknown>;
}

interface StoreModel {
  id: string;
  schemaVersion: string;
  typeDefinitions: TypeDefinition[];
  typeCount: number;
}

interface FGAStore {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  model: StoreModel | null;
}

interface FGAData {
  stores: FGAStore[];
  totalStores: number;
  totalTypes: number;
  error?: string;
  message?: string;
  setupSteps?: string[];
}

interface CheckResult {
  allowed: boolean | null;
  loading: boolean;
  error: string | null;
}

// ─── Setup Instructions ───

function SetupCard({ message, steps }: { message: string; steps: string[] }) {
  return (
    <Card className="border-amber-300/50 bg-amber-50/50 dark:bg-amber-900/10">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-2">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              OpenFGA unreachable
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400">{message}</p>
            <ol className="space-y-1">
              {steps.map((step, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400"
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

// ─── Type Definition Tree ───

function TypeTree({ typeDef }: { typeDef: TypeDefinition }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="font-mono text-sm font-semibold">{typeDef.type}</span>
        </div>
        <Badge variant="secondary" className="text-xs">
          {typeDef.relations.length} relation{typeDef.relations.length !== 1 ? "s" : ""}
        </Badge>
      </button>
      {open && typeDef.relations.length > 0 && (
        <div className="divide-y">
          {typeDef.relations.map((rel) => (
            <div
              key={rel}
              className="flex items-center gap-2 px-5 py-1.5 text-sm"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
              <span className="font-mono text-muted-foreground">{rel}</span>
            </div>
          ))}
        </div>
      )}
      {open && typeDef.relations.length === 0 && (
        <p className="px-5 py-2 text-xs text-muted-foreground">No relations defined</p>
      )}
    </div>
  );
}

// ─── Store Card ───

function StoreCard({
  store,
  isSelected,
  onSelect,
}: {
  store: FGAStore;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-4 transition-colors ${
        isSelected
          ? "border-primary/50 bg-primary/5"
          : "hover:bg-muted/30"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{store.name}</p>
          <p className="font-mono text-xs text-muted-foreground mt-0.5 truncate">{store.id}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {store.model && (
            <Badge variant="secondary" className="text-xs">
              {store.model.typeCount} types
            </Badge>
          )}
          {isSelected && <div className="h-2 w-2 rounded-full bg-primary" />}
        </div>
      </div>
      {store.model && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Model {store.model.id.slice(0, 8)}… · schema {store.model.schemaVersion}
        </p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Updated {new Date(store.updatedAt).toLocaleDateString()}
      </p>
    </button>
  );
}

// ─── Check Query Form ───

function CheckQueryForm({ stores }: { stores: FGAStore[] }) {
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [user, setUser] = useState("");
  const [relation, setRelation] = useState("");
  const [object, setObject] = useState("");
  const [result, setResult] = useState<CheckResult>({
    allowed: null,
    loading: false,
    error: null,
  });

  const handleCheck = async () => {
    if (!storeId || !user || !relation || !object) return;
    setResult({ allowed: null, loading: true, error: null });

    const res = await apiFetch<{ allowed: boolean }>("/api/openfga/check", {
      method: "POST",
      body: JSON.stringify({ storeId, tupleKey: { user, relation, object } }),
    });

    if (res.error) {
      setResult({ allowed: null, loading: false, error: res.error });
    } else {
      setResult({
        allowed: res.data?.allowed ?? false,
        loading: false,
        error: null,
      });
    }
  };

  return (
    <Card>
      <div className="px-4 pt-4 pb-2">
        <h3 className="text-sm font-semibold">Test Authorization Check</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Evaluate a relationship tuple against the model
        </p>
      </div>
      <CardContent className="space-y-3 pt-2">
        {/* Store selector */}
        <div>
          <label className="text-xs font-medium text-muted-foreground">Store</label>
          <div className="relative mt-1">
            <select
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="w-full h-9 appearance-none rounded-md border bg-background px-3 pr-8 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id.slice(0, 12)}…)
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>

        {/* Tuple fields */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">User</label>
            <Input
              placeholder="user:alice"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="mt-1 h-9 font-mono text-xs"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Relation</label>
            <Input
              placeholder="viewer"
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
              className="mt-1 h-9 font-mono text-xs"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Object</label>
            <Input
              placeholder="document:readme"
              value={object}
              onChange={(e) => setObject(e.target.value)}
              className="mt-1 h-9 font-mono text-xs"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={handleCheck}
            disabled={!storeId || !user || !relation || !object || result.loading}
          >
            {result.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5 mr-1" />
            )}
            Check
          </Button>

          {result.error && (
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              {result.error}
            </div>
          )}

          {result.allowed !== null && !result.error && (
            <div
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold ${
                result.allowed
                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                  : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              }`}
            >
              {result.allowed ? (
                <>
                  <Check className="h-4 w-4" />
                  Allowed
                </>
              ) : (
                <>
                  <X className="h-4 w-4" />
                  Denied
                </>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───

export default function OpenFGAPage() {
  const [data, setData] = useState<FGAData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStoreId, setSelectedStoreId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<FGAData>("/api/openfga");
    if (res.error) {
      setError(res.error);
    } else {
      setData(res.data ?? null);
      if (res.data?.stores?.length && !selectedStoreId) {
        setSelectedStoreId(res.data.stores[0].id);
      }
    }
    setLoading(false);
  }, [selectedStoreId]);

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedStore = data?.stores.find((s) => s.id === selectedStoreId);

  return (
    <>
      <AdminHeader
        title="OpenFGA"
        description="Authorization model viewer and relationship checker"
        icon={ShieldCheck}
      />

      <main className="p-6 space-y-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          {!loading && data && (
            <>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{data.totalStores}</span> stores
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{data.totalTypes}</span> total types
              </div>
            </>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          <span className="ml-1">Refresh</span>
        </Button>
      </div>

      {/* Error */}
      {error && (
        <Card className="mb-4 border-destructive/30">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Unreachable */}
      {!loading && data?.error === "openfga_unreachable" && (
        <SetupCard
          message={data.message ?? ""}
          steps={data.setupSteps ?? []}
        />
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      )}

      {/* Content */}
      {!loading && data?.stores && data.stores.length > 0 && (
        <div className="space-y-4">
          {/* Store list */}
          <div>
            <h3 className="text-sm font-semibold mb-2">Stores</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {data.stores.map((store) => (
                <StoreCard
                  key={store.id}
                  store={store}
                  isSelected={selectedStoreId === store.id}
                  onSelect={() => setSelectedStoreId(store.id)}
                />
              ))}
            </div>
          </div>

          {/* Selected store model */}
          {selectedStore?.model && (
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                Type Definitions
                <span className="font-normal text-muted-foreground font-mono text-xs">
                  {selectedStore.name}
                </span>
              </h3>
              <div className="space-y-2">
                {selectedStore.model.typeDefinitions.map((td) => (
                  <TypeTree key={td.type} typeDef={td} />
                ))}
              </div>
            </div>
          )}

          {selectedStore && !selectedStore.model && (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-10 text-center">
                <ShieldCheck className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground">
                  No authorization model found for this store
                </p>
              </CardContent>
            </Card>
          )}

          {/* Check form */}
          <CheckQueryForm stores={data.stores} />
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data?.stores?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <ShieldCheck className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">No stores found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create an OpenFGA store to get started
            </p>
          </CardContent>
        </Card>
      )}
      </main>
    </>
  );
}
