"use client";

import { useCallback, useMemo } from "react";
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
          <Input
            key={descriptor.key}
            type="search"
            className="h-9 w-56"
            aria-label={descriptor.label}
            placeholder={descriptor.label}
            value={values[descriptor.key] ?? ""}
            onChange={(event) => onChange(descriptor.key, event.target.value)}
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
