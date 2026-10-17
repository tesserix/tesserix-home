"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  addressSchema,
  type VenueAddress,
} from "@tesserix/questionnaires/locations";
import { z } from "zod";
import { questionnaireClientId } from "./client-id";
type Props = { country: string; onSelect: (address: VenueAddress) => void };
export function AddressLookup({ country, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState({ q: "", country: "" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced({ q: query.trim(), country }),
      400,
    );
    return () => clearTimeout(timer);
  }, [query, country]);
  const enabled =
    !!country &&
    open &&
    debounced.country === country &&
    debounced.q === query.trim() &&
    debounced.q.length >= 3;
  const result = useQuery({
    queryKey: ["questionnaire-address", debounced],
    enabled,
    staleTime: 60000,
    gcTime: 120000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/questionnaires/location", {
        method: "POST",
        credentials: "omit",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Questionnaire-Client": questionnaireClientId(),
        },
        body: JSON.stringify(debounced),
      });
      if (!response.ok)
        throw new Error(
          "Address search is unavailable. You can enter all address details manually below.",
        );
      return z
        .object({ data: z.array(addressSchema).max(8) })
        .parse(await response.json()).data;
    },
  });
  const suggestions = enabled ? (result.data ?? []) : [];
  const choose = (address: VenueAddress) => {
    onSelect(address);
    setQuery(address.description);
    setOpen(false);
    setActive(-1);
  };
  return (
    <div className="space-y-2 rounded-xl bg-stone-50 p-4">
      <label htmlFor="venue-address-search" className="font-medium">
        Find the venue address (optional)
      </label>
      <p id="address-search-hint" className="text-sm text-stone-600">
        Choose a country, then search for a public venue or street. Address
        search uses our existing location provider. Check the result or enter
        details manually below.
      </p>
      <input
        id="venue-address-search"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="venue-address-options"
        aria-expanded={suggestions.length > 0}
        aria-activedescendant={
          active >= 0 && suggestions[active]
            ? `venue-address-${active}`
            : undefined
        }
        aria-describedby="address-search-hint address-search-status"
        autoComplete="off"
        disabled={!country}
        maxLength={150}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            setActive(-1);
          }
          if (e.key === "ArrowDown" && suggestions.length) {
            e.preventDefault();
            setActive((i) => (i + 1) % suggestions.length);
          }
          if (e.key === "ArrowUp" && suggestions.length) {
            e.preventDefault();
            setActive((i) => (i + suggestions.length - 1) % suggestions.length);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (suggestions[active]) choose(suggestions[active]);
          }
        }}
        className="min-h-12 w-full min-w-0 text-base rounded-xl border border-stone-300 bg-white p-3.5 disabled:opacity-60"
      />
      {suggestions.length > 0 && (
        <ul
          id="venue-address-options"
          role="listbox"
          aria-label="Venue address suggestions"
          className="max-h-64 overflow-auto rounded-xl border border-stone-300 bg-white"
        >
          {suggestions.map((address, i) => (
            <li
              id={`venue-address-${i}`}
              role="option"
              aria-selected={active === i}
              key={`${address.description}-${i}`}
              className={active === i ? "bg-emerald-50" : ""}
            >
              <button
                type="button"
                tabIndex={-1}
                onClick={() => choose(address)}
                className="min-h-12 w-full p-3 text-left text-base hover:bg-emerald-50"
              >
                {address.description}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p
        id="address-search-status"
        role="status"
        className="text-sm text-stone-600"
      >
        {enabled && result.isFetching
          ? "Searching…"
          : enabled && result.isError
            ? "Address search is unavailable. You can enter all address details manually below."
            : enabled && result.isSuccess && !suggestions.length
              ? "No matching addresses. Try a nearby street or enter the details manually."
              : ""}
      </p>
    </div>
  );
}
