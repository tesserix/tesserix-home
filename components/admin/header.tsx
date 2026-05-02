"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import type { LucideIcon } from "lucide-react";
import { Bell, Search, Loader2, AlertCircle } from "lucide-react";
import { Button, Input } from "@tesserix/web";

interface AdminHeaderProps {
  title: string;
  description?: string;
  icon?: React.ReactNode | LucideIcon;
}

export function AdminHeader({ title, description, icon: IconProp }: AdminHeaderProps) {
  // Lucide icons may be forwardRef objects (not plain functions) in React 19
  const isComponent =
    IconProp &&
    (typeof IconProp === "function" ||
      (typeof IconProp === "object" && "render" in IconProp));
  const iconElement = isComponent
    ? (() => { const IC = IconProp as LucideIcon; return <IC className="h-6 w-6 text-muted-foreground" />; })()
    : IconProp;

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-3">
          {iconElement}
          <div>
            <h1 className="text-xl font-semibold text-foreground">{title}</h1>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <HeaderSearch />

          {/* Notifications */}
          <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
            <Bell className="h-5 w-5" aria-hidden="true" />
            <span
              className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary"
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
    </header>
  );
}

// ─── Inline search ─────────────────────────────────────────────────
//
// Type ≥3 chars → debounced fetch → dropdown of grouped results across
// every cross-product source. Click navigates to the result's detail
// page; Enter (or "View all" link) jumps to the full /admin/search
// surface for the same query.

interface UserSearchResult {
  source: string;
  kind: string;
  email: string;
  label: string;
  sublabel?: string;
  href: string;
  matchedField: string;
  updatedAt: string | null;
}

interface SearchResponse {
  query: string;
  results: UserSearchResult[];
  failures: { source: string; message: string }[];
  truncated: boolean;
}

const MIN_QUERY_LENGTH = 3;
const INLINE_LIMIT = 8;

const SOURCE_TONE: Record<string, string> = {
  tenants: "bg-emerald-500/15 text-emerald-700",
  leads: "bg-sky-500/15 text-sky-700",
  invitations: "bg-amber-500/15 text-amber-700",
  platform_tickets: "bg-violet-500/15 text-violet-700",
  onboarding: "bg-muted text-muted-foreground",
};

const fetcher = (u: string) =>
  fetch(u, { credentials: "include" }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

function HeaderSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 250ms debounce — same as the dedicated /admin/search page so the
  // two surfaces feel consistent.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const valid = debounced.length >= MIN_QUERY_LENGTH;
  const swrKey =
    valid && open ? `/api/admin/users/search?q=${encodeURIComponent(debounced)}` : null;
  const { data, error, isLoading } = useSWR<SearchResponse>(swrKey, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });

  const inlineResults = useMemo(
    () => (data?.results ?? []).slice(0, INLINE_LIMIT),
    [data],
  );
  const totalCount = data?.results.length ?? 0;
  const hasMore = totalCount > INLINE_LIMIT;

  // Reset the active row when the result set changes so the keyboard
  // selection isn't pointing past the end.
  useEffect(() => {
    setActiveIndex(0);
  }, [data]);

  // Click outside → close dropdown.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function navigateToAll() {
    if (!debounced) return;
    setOpen(false);
    router.push(`/admin/search?q=${encodeURIComponent(debounced)}`);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const picked = inlineResults[activeIndex];
      if (picked) {
        setOpen(false);
        router.push(picked.href);
      } else {
        navigateToAll();
      }
      return;
    }
    if (!open || inlineResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, inlineResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    }
  }

  return (
    <>
      {/* Desktop search */}
      <div ref={wrapRef} className="relative hidden md:block">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          placeholder="Search tenants, leads, tickets…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="w-72 pl-9"
          aria-label="Search users by email, tenant name, or lead name"
          aria-autocomplete="list"
          aria-controls="header-search-results"
          aria-expanded={open && valid}
        />
        {isLoading && valid && open && (
          <Loader2
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        )}

        {open && valid && data && (
          <div
            id="header-search-results"
            role="listbox"
            className="absolute right-0 top-full z-40 mt-2 w-[28rem] max-w-[90vw] overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            {error ? (
              <div className="flex items-start gap-2 p-3 text-sm">
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <span>Search failed. Try again.</span>
              </div>
            ) : inlineResults.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No matches for &ldquo;{debounced}&rdquo;
              </p>
            ) : (
              <ul className="max-h-[60vh] overflow-y-auto py-1">
                {inlineResults.map((r, i) => {
                  const active = i === activeIndex;
                  return (
                    <li
                      key={`${r.source}-${i}`}
                      role="option"
                      aria-selected={active}
                    >
                      <Link
                        href={r.href}
                        onClick={() => setOpen(false)}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={
                          "flex items-start gap-3 px-3 py-2 transition-colors " +
                          (active ? "bg-muted/60" : "hover:bg-muted/40")
                        }
                      >
                        <span
                          className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${SOURCE_TONE[r.source] ?? "bg-muted"}`}
                        >
                          {r.kind}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {highlight(r.label, debounced)}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {highlight(r.email, debounced)}
                            {r.sublabel ? <> · {r.sublabel}</> : null}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            {data.failures.length > 0 && (
              <div className="border-t border-border bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                Showing partial results — {data.failures.map((f) => f.source).join(", ")}{" "}
                unavailable.
              </div>
            )}

            {(hasMore || inlineResults.length > 0) && (
              <button
                type="button"
                onClick={navigateToAll}
                className="block w-full border-t border-border px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                {hasMore
                  ? `View all ${data.truncated ? "100+" : totalCount} results →`
                  : "Open in full search page →"}
              </button>
            )}
          </div>
        )}

        {open && query.length > 0 && !valid && (
          <div className="absolute right-0 top-full z-40 mt-2 w-72 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground shadow-lg">
            Type at least {MIN_QUERY_LENGTH} characters.
          </div>
        )}
      </div>

      {/* Mobile: button → navigate to full search page */}
      <Link href="/admin/search" className="md:hidden" aria-label="Open search">
        <Button variant="ghost" size="icon" asChild>
          <span>
            <Search className="h-5 w-5" aria-hidden="true" />
          </span>
        </Button>
      </Link>
    </>
  );
}

function highlight(text: string, q: string): React.ReactNode {
  if (!q || !text) return text;
  const lower = text.toLowerCase();
  const i = lower.indexOf(q);
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-semibold text-foreground">
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}
