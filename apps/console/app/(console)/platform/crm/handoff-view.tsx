"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Callout, CalloutDescription, Input } from "@tesserix/web";
import { SurfaceStateView, type SurfaceState } from "@/components/kit/states";
import type { ConversionSignal, ConversionState } from "@/lib/crm-conversion";
import { linkConversion } from "./[organisation]/actions";

export interface HandoffItem {
  opportunityId: string;
  organisationId: string;
  organisationName: string;
  /** Null for a migrated deal — see `HandoffRow.product` in crm-repo.ts.
   *  Rendered as "Unassigned", the same word the work queue already uses
   *  for an opportunity with no product set. */
  product: string | null;
  closedAt: string | null;
  signal: ConversionSignal;
}

export interface ProductOption {
  context: string;
  name: string;
}

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Callout role="alert" variant="destructive" className="mt-2">
      <CalloutDescription>{message}</CalloutDescription>
    </Callout>
  );
}

/**
 * A signal's badge copy and tone. `unknown` and `none` are deliberately
 * worded apart — "Unknown" vs. "Not converted" — because they answer
 * different questions ("we couldn't check" vs. "the product said no"), and
 * collapsing them into one label is exactly the false negative Task 9's
 * contract exists to prevent: a merchant who is actually live would read as
 * having stalled.
 */
const SIGNAL_COPY: Record<ConversionState, { label: string; tone: "neutral" | "warning" | "success" | "info" }> = {
  unknown: { label: "Unknown — could not check", tone: "neutral" },
  none: { label: "Not converted", tone: "neutral" },
  in_flight: { label: "In progress", tone: "info" },
  complete: { label: "Converted", tone: "success" },
};

/**
 * The one `unknown` that is not a failed check. A migrated deal carries no
 * product (see `HandoffRow.product`), so `fetchRowSignal` never asks anyone
 * anything about it — there is no product admin API to address the question
 * to. "Could not check" says a check was attempted and did not come back,
 * which for these rows is simply untrue, and it reads as a system fault an
 * operator might wait out. Nothing was checked, nothing will be until the
 * deal has a product, and the row is worked by hand either way.
 *
 * `signal.product === null` is exactly this case and only this case — the
 * `ConversionSignal.product` contract says so.
 */
const NOT_CHECKED_COPY = { label: "Not checked — no product", tone: "neutral" as const };

function SignalBadge({ signal }: { signal: ConversionSignal }) {
  const copy =
    signal.state === "unknown" && signal.product === null
      ? NOT_CHECKED_COPY
      : SIGNAL_COPY[signal.state];
  return (
    <Badge variant={copy.tone === "success" ? "default" : "secondary"}>
      {copy.label}
      {signal.state === "in_flight" && signal.idleHours !== undefined
        ? ` · idle ${signal.idleHours}h`
        : ""}
    </Badge>
  );
}

/**
 * One organisation waiting for handoff.
 *
 * A `complete` signal with a `ref` is shown as a SUGGESTION — the product's
 * own answer for this email — never linked on render. Confirming it is the
 * one thing that turns the suggestion into a durable `converted_*` write,
 * through `linkConversion` with `method: "matched"`. Everything else
 * (`none`, `in_flight`, `unknown`, or `complete` with no usable `ref`) has no
 * suggestion to confirm, but an operator can still link a conversion by
 * hand — `method: "manual"` — because a wrong or missing signal from one
 * product is not evidence the organisation never converted at all.
 */
function HandoffRowItem({
  item,
  products,
}: {
  item: HandoffItem;
  products: readonly ProductOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  // Defaults to the row's own product when it has one. A migrated row has
  // none, and the default is then the empty string — an explicit "Select a
  // product…" the operator must answer, NOT the first entry in `products`,
  // which a bare `<select>` would otherwise silently pre-select and file the
  // conversion against the wrong product on a single click.
  const [manualProduct, setManualProduct] = useState(item.product ?? "");
  const [manualRef, setManualRef] = useState("");
  const [manualLabel, setManualLabel] = useState("");

  // Captured as `{ ref, label }`, not the whole `item.signal` object: the
  // guard's `item.signal.ref` check narrows that specific access, but does
  // not carry over to `suggestion.ref` if `suggestion` were the signal
  // itself — this shape makes `ref` genuinely non-optional below, with no
  // `!` needed to tell the compiler what the guard already proved.
  //
  // `product` is captured here too, and the guard requires it: a definite
  // `complete` can only come from a product that was actually asked, so it
  // is never null in practice — capturing it is what proves that to the
  // compiler without a `!`, now that a migrated row's signal can carry a
  // null product (always with `state: "unknown"`, which has no suggestion).
  const suggestion =
    item.signal.state === "complete" && item.signal.ref && item.signal.product
      ? {
          ref: item.signal.ref,
          label: item.signal.label,
          product: item.signal.product,
        }
      : null;

  const confirmSuggestion = () => {
    if (!suggestion) return;
    setError(null);
    startTransition(async () => {
      const result = await linkConversion({
        organisationId: item.organisationId,
        product: suggestion.product,
        ref: suggestion.ref,
        label: suggestion.label,
        method: "matched",
      });
      if (!result.ok) {
        setError(result.message);
        // Refreshed even on failure: the one error this button can hit is
        // "already linked" (Ruling 30) — meaning some OTHER row for this
        // same organisation just won the race this click lost. Without a
        // refresh, this row's stale `complete` signal and its still-live
        // Confirm button stay on screen, telling the operator the thing
        // they were just told is already handled is still pending — wrong
        // at the exact moment the guard just corrected them.
        router.refresh();
        return;
      }
      router.refresh();
    });
  };

  const submitManual = () => {
    setError(null);
    startTransition(async () => {
      const result = await linkConversion({
        organisationId: item.organisationId,
        product: manualProduct,
        ref: manualRef,
        label: manualLabel || undefined,
        method: "manual",
      });
      if (!result.ok) {
        setError(result.message);
        // Refreshed on failure for the same reason `confirmSuggestion` is,
        // and more so: the manual path is the likelier race loser — it is
        // open for as long as the operator spends typing a reference, which
        // is the whole window another row (or another operator) has to link
        // this organisation first. Without this, the row and its still-live
        // form stay on screen after the guard has just said the work is
        // already done.
        router.refresh();
        return;
      }
      setManualOpen(false);
      setManualRef("");
      setManualLabel("");
      router.refresh();
    });
  };

  const productName = item.product
    ? (products.find((p) => p.context === item.product)?.name ?? item.product)
    : "Unassigned";

  return (
    <li className="border-t border-border py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{item.organisationName}</span>
            <span className="text-muted-foreground">{productName}</span>
            <SignalBadge signal={item.signal} />
          </div>
          {item.closedAt ? (
            <div className="mt-1 text-muted-foreground">
              Won {new Date(item.closedAt).toLocaleDateString()}
            </div>
          ) : null}
          {suggestion ? (
            <div className="mt-1 text-muted-foreground">
              Suggested match: {suggestion.label ?? suggestion.ref}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {suggestion ? (
            <Button type="button" size="sm" disabled={pending} onClick={confirmSuggestion}>
              {pending ? "Linking…" : "Confirm match"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setManualOpen((open) => !open)}
          >
            Link manually
          </Button>
        </div>
      </div>

      {manualOpen ? (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <div>
            <label
              className="text-xs uppercase tracking-wide text-muted-foreground"
              htmlFor={`manual-product-${item.opportunityId}`}
            >
              Product
            </label>
            <select
              id={`manual-product-${item.opportunityId}`}
              className="mt-1 block h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={manualProduct}
              disabled={pending}
              onChange={(event) => setManualProduct(event.target.value)}
            >
              {/* Only rendered when there is no product to default to. A row
                  that HAS one starts on it, and this placeholder never
                  appears — so an operator can never be shown a blank
                  selection for a deal whose product is already known. */}
              {item.product ? null : (
                <option value="">Select a product…</option>
              )}
              {products.map((p) => (
                <option key={p.context} value={p.context}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              className="text-xs uppercase tracking-wide text-muted-foreground"
              htmlFor={`manual-ref-${item.opportunityId}`}
            >
              Reference
            </label>
            <Input
              id={`manual-ref-${item.opportunityId}`}
              className="mt-1 h-9"
              value={manualRef}
              disabled={pending}
              onChange={(event) => setManualRef(event.target.value)}
              placeholder="tenant_9f2"
            />
          </div>
          <div>
            <label
              className="text-xs uppercase tracking-wide text-muted-foreground"
              htmlFor={`manual-label-${item.opportunityId}`}
            >
              Label
            </label>
            <Input
              id={`manual-label-${item.opportunityId}`}
              className="mt-1 h-9"
              value={manualLabel}
              disabled={pending}
              onChange={(event) => setManualLabel(event.target.value)}
              placeholder="Bondi Store"
            />
          </div>
          <Button
            type="button"
            size="sm"
            // `manualProduct` is only ever empty on a migrated row the
            // operator has not answered the product question for yet;
            // `linkConversion` would refuse it server-side anyway, and
            // refusing it here says so before the round trip.
            disabled={pending || manualRef.trim().length === 0 || manualProduct.length === 0}
            onClick={submitManual}
          >
            {pending ? "Linking…" : "Link"}
          </Button>
        </div>
      ) : null}

      <ErrorNote message={error} />
    </li>
  );
}

export function HandoffView({
  items,
  state,
  emptyMessage,
  products,
}: {
  items: readonly HandoffItem[];
  state: SurfaceState;
  emptyMessage: string;
  products: readonly ProductOption[];
}) {
  if (state.kind !== "ready") {
    return <SurfaceStateView state={state} emptyMessage={emptyMessage} />;
  }
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <HandoffRowItem key={item.opportunityId} item={item} products={products} />
      ))}
    </ul>
  );
}
