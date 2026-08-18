"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tesserix/web";

export interface FilterDescriptor {
  key: string;
  label: string;
  type: "select" | "search";
  options?: { value: string; label: string }[];
}

export type FilterValues = Record<string, string>;

/**
 * Serialise filter values into a query string, dropping blanks so the URL
 * stays clean and so a cleared filter leaves no trace behind.
 */
export function filtersToQuery(values: FilterValues): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== "") {
      params.set(key, value);
    }
  }
  return params.toString();
}

/**
 * Read filter values back out of a query string. Params that no surface
 * declared are ignored — a URL is untrusted input, and a saved view must not
 * be able to smuggle state into a page that never asked for it.
 */
export function queryToFilters(
  params: URLSearchParams,
  descriptors: readonly FilterDescriptor[],
): FilterValues {
  const values: FilterValues = {};
  for (const descriptor of descriptors) {
    const raw = params.get(descriptor.key);
    if (raw !== null && raw !== "") {
      values[descriptor.key] = raw;
    }
  }
  return values;
}

/**
 * The page param a filter mutation resets. A filter change re-shapes the whole
 * result set, so the page the operator was on no longer means anything.
 */
export const PAGE_PARAM = "page";

/**
 * Apply filter values onto an existing query string, preserving every param a
 * surface owns that is not a filter — `sort`, a tab id, a deep-linked row.
 *
 * `filtersToQuery` deliberately builds a *fresh* query from filter values only
 * (it is the serialisation half of the round-trip and must stay that way), so
 * the merge lives here instead: replacing the whole query string with the
 * filter query is what silently destroys unrelated state.
 *
 * `page` is dropped rather than merged: narrowing a filter while on page 5
 * would otherwise land on an empty page 5, which `resolveState` would report
 * as `filtered-empty` — a correct-looking state for an incorrect cause.
 */
export function mergeFiltersIntoQuery(
  current: URLSearchParams,
  descriptors: readonly FilterDescriptor[],
  values: FilterValues,
): string {
  const next = new URLSearchParams(current.toString());
  next.delete(PAGE_PARAM);
  for (const descriptor of descriptors) {
    const value = values[descriptor.key] ?? "";
    if (value === "") {
      next.delete(descriptor.key);
    } else {
      next.set(descriptor.key, value);
    }
  }
  return next.toString();
}

/** The default for `dropOnChange`. A module constant, not a fresh `[]` per
 *  render: the array is a dependency of the memoised `push`, and a new
 *  identity every render would rebuild every callback below it. Callers
 *  passing their own list should hold it at module scope for the same
 *  reason. */
const DROP_NOTHING: readonly string[] = [];

export interface UrlFilters {
  values: FilterValues;
  set(key: string, value: string): void;
  clear(): void;
}

/**
 * Filter state lives in the URL, not in component state: that is what makes
 * deep links and saved views work.
 *
 * `dropOnChange` names params a filter mutation must delete alongside the
 * merge — the keyset cursors of surfaces that page by `?cursor=` rather than
 * by the `?page=` param `mergeFiltersIntoQuery` already clears. Narrowing a
 * filter while on page 3 otherwise lands the operator on an empty page 3 of
 * a now-shorter list, which on screen is indistinguishable from "nothing
 * matches" rather than "you are past the end".
 *
 * A list rather than a single key, and a parameter rather than two hooks:
 * the browse surface drops its one `cursor`, and the CRM queues drop BOTH of
 * theirs (one filter bar drives both queues, so a narrowed filter invalidates
 * every position on the page at once). Those two surfaces each carried a
 * near-verbatim copy of this hook differing in nothing else, and a race guard
 * maintained in three places is a race guard that eventually only holds in
 * one.
 *
 * The drop happens inside `push`, so the merge and the drop travel in one
 * `router.replace` and a quick filter change can never race a separate
 * cursor-clearing navigation into overwriting it.
 */
export function useUrlFilters(
  descriptors: FilterDescriptor[],
  dropOnChange: readonly string[] = DROP_NOTHING,
): UrlFilters {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const searchString = searchParams.toString();

  const values = useMemo(
    () => queryToFilters(new URLSearchParams(searchString), descriptors),
    [searchString, descriptors],
  );

  // `router.replace` is asynchronous, so `searchParams` still holds the old
  // query for the rest of the tick. Two mutations in one round-trip would
  // therefore both read the pre-change URL and the first would be lost. The
  // query we last pushed is held here and used as the base until the URL
  // catches up (or changes underneath us, e.g. the back button).
  const pendingRef = useRef<string | null>(null);
  useEffect(() => {
    pendingRef.current = null;
  }, [searchString]);

  const push = useCallback(
    (update: (previous: FilterValues) => FilterValues) => {
      const current = new URLSearchParams(pendingRef.current ?? searchString);
      const previous = queryToFilters(current, descriptors);
      const merged = new URLSearchParams(
        mergeFiltersIntoQuery(current, descriptors, update(previous)),
      );
      for (const param of dropOnChange) merged.delete(param);
      const query = merged.toString();
      pendingRef.current = query;
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [router, pathname, searchString, descriptors, dropOnChange],
  );

  const set = useCallback(
    (key: string, value: string) => {
      push((previous) => {
        const next = { ...previous, [key]: value };
        if (value === "") {
          delete next[key];
        }
        return next;
      });
    },
    [push],
  );

  const clear = useCallback(() => push(() => ({})), [push]);

  return { values, set, clear };
}

// Radix Select cannot hold an empty-string item value, so "any" stands in for
// "no filter" in the widget and is translated back to "" at the boundary.
const ANY = "__any__";

/** How long typing must pause before the URL (and therefore the query) moves. */
export const SEARCH_DEBOUNCE_MS = 300;

export interface SearchFilterInputProps {
  label: string;
  /** The committed value, as read back out of the URL. */
  value: string;
  onCommit(next: string): void;
}

/**
 * A search box whose keystrokes do not each become a navigation.
 *
 * The input is driven by local state, not by the URL: a controlled input fed
 * by async router state drops characters under fast typing, and every
 * keystroke would otherwise trigger a `router.replace` and a refetch on a
 * server-driven surface. The URL is updated once typing pauses, and
 * immediately on blur or Enter so the user can force it. An external change
 * to the value (back button, "clear filters") still wins over the draft.
 */
export function SearchFilterInput({ label, value, onCommit }: SearchFilterInputProps) {
  const [draft, setDraft] = useState(value);
  const committedRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onCommitRef.current = onCommit;
  });

  useEffect(() => {
    if (value !== committedRef.current) {
      committedRef.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    if (draft === committedRef.current) {
      return;
    }
    const timer = setTimeout(() => {
      timerRef.current = null;
      committedRef.current = draft;
      onCommitRef.current(draft);
    }, SEARCH_DEBOUNCE_MS);
    timerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (timerRef.current === timer) {
        timerRef.current = null;
      }
    };
  }, [draft]);

  // Blur and Enter commit immediately. The in-flight debounce has to be
  // cancelled too, or it re-fires with the same value a moment later and
  // costs a redundant `router.replace` (and the refetch behind it).
  function flush() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (draft !== committedRef.current) {
      committedRef.current = draft;
      onCommitRef.current(draft);
    }
  }

  return (
    <Input
      type="search"
      className="h-9 w-56"
      aria-label={label}
      placeholder={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={flush}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          flush();
        }
      }}
    />
  );
}

export interface FilterBarProps {
  descriptors: FilterDescriptor[];
  values: FilterValues;
  onChange(key: string, value: string): void;
  onClear(): void;
}

export function FilterBar({ descriptors, values, onChange, onClear }: FilterBarProps) {
  const hasActiveFilter = descriptors.some((d) => (values[d.key] ?? "") !== "");

  return (
    <div className="flex flex-wrap items-center gap-2" role="search">
      {descriptors.map((descriptor) =>
        descriptor.type === "search" ? (
          <SearchFilterInput
            key={descriptor.key}
            label={descriptor.label}
            value={values[descriptor.key] ?? ""}
            onCommit={(next) => onChange(descriptor.key, next)}
          />
        ) : (
          <Select
            key={descriptor.key}
            value={values[descriptor.key] || ANY}
            onValueChange={(next) => onChange(descriptor.key, next === ANY ? "" : next)}
          >
            <SelectTrigger size="sm" className="w-44" aria-label={descriptor.label}>
              <SelectValue placeholder={descriptor.label} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{`All ${descriptor.label.toLowerCase()}`}</SelectItem>
              {(descriptor.options ?? []).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
      )}
      {hasActiveFilter ? (
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
