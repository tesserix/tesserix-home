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

export interface UrlFilters {
  values: FilterValues;
  set(key: string, value: string): void;
  clear(): void;
}

/**
 * Filter state lives in the URL, not in component state: that is what makes
 * deep links and saved views work.
 */
export function useUrlFilters(descriptors: FilterDescriptor[]): UrlFilters {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const values = useMemo(
    () => queryToFilters(new URLSearchParams(searchParams.toString()), descriptors),
    [searchParams, descriptors],
  );

  const push = useCallback(
    (next: FilterValues) => {
      const query = filtersToQuery(next);
      router.replace(query ? `${pathname}?${query}` : pathname);
    },
    [router, pathname],
  );

  const set = useCallback(
    (key: string, value: string) => {
      const next = { ...values, [key]: value };
      if (value === "") {
        delete next[key];
      }
      push(next);
    },
    [values, push],
  );

  const clear = useCallback(() => push({}), [push]);

  return { values, set, clear };
}

// Radix Select cannot hold an empty-string item value, so "any" stands in for
// "no filter" in the widget and is translated back to "" at the boundary.
const ANY = "__any__";

/** How long typing must pause before the URL (and therefore the query) moves. */
export const SEARCH_DEBOUNCE_MS = 300;

interface SearchFilterInputProps {
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
function SearchFilterInput({ label, value, onCommit }: SearchFilterInputProps) {
  const [draft, setDraft] = useState(value);
  const committedRef = useRef(value);
  const onCommitRef = useRef(onCommit);

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
      committedRef.current = draft;
      onCommitRef.current(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  function flush() {
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
