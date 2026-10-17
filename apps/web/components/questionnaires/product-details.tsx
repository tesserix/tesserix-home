"use client";
import { useState } from "react";
import { label, suggestedVariants, VARIANTS } from "@tesserix/questionnaires";
type Props = {
  country: string;
  region: string;
  families: string[];
  value: string[];
  onChange: (value: string[]) => void;
};
export function ProductDetails({
  country,
  region,
  families,
  value,
  onChange,
}: Props) {
  const [all, setAll] = useState(false);
  const suggested = suggestedVariants(country, region, families, all);
  const items = VARIANTS.filter(
    (v) =>
      families.includes(v.family) &&
      (suggested.includes(v) || value.includes(v.id)),
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600">
        {region ? `${region}, ` : ""}
        {country || "Choose a venue country"} · suggestions to explore, not
        assumptions about your taste. Fresh, dairy, hot and prepared foods need
        suitable equipment and approved handling.
      </p>
      <label className="flex min-h-12 cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          className="h-5 w-5 shrink-0 accent-emerald-800"
        />
        Explore all cuisines
      </label>
      {!families.length && (
        <p className="text-sm text-stone-600">
          Choose product categories above to see optional item details.
        </p>
      )}
      <p role="status" className="text-sm text-stone-600">
        {value.length} of 12 item details selected
      </p>
      {families.map((family) => {
        const options = items.filter((v) => v.family === family);
        if (!options.length) return null;
        return (
          <details
            key={family}
            className="rounded-xl border border-stone-200 bg-white p-3"
          >
            <summary className="min-h-11 cursor-pointer content-center font-medium">
              {label(family)} · {options.length} ideas
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {options.map((item) => (
                <label
                  key={item.id}
                  className="flex min-h-12 cursor-pointer items-start gap-3 rounded-lg border border-stone-200 p-3 text-sm has-checked:border-emerald-700 has-checked:bg-emerald-50"
                >
                  <input
                    type="checkbox"
                    checked={value.includes(item.id)}
                    disabled={value.length >= 12 && !value.includes(item.id)}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...value, item.id]
                          : value.filter((v) => v !== item.id),
                      )
                    }
                    className="mt-1 h-5 w-5 shrink-0 accent-emerald-800"
                  />
                  <span>
                    {item.label}
                    {item.handling && (
                      <span className="block text-xs text-stone-500">
                        {item.handling === "hot"
                          ? "Hot serving option"
                          : "Chilled serving option"}{" "}
                        · assess safe handling
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}
