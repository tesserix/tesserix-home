"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Callout,
  CalloutDescription,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@tesserix/web";
import { sourceLabel } from "@/lib/audit";
import {
  NO_REASON_CODES,
  NO_REASON_CODE_GAPS,
  hasReasonCodes,
  reasonCodesFor,
  type LifecycleVerb,
  type ReasonCodeCatalog,
  type ReasonCodeGap,
  type ReasonCodeGaps,
} from "@/lib/tenant-lifecycle";
import { splitTenantId, type EstateTenant } from "@/lib/tenants";
import { setTenantLifecycleAction } from "./actions";

/**
 * Suspending and unsuspending one tenant, from its row in the directory.
 *
 * The write itself lives in `lib/tenant-lifecycle-write.ts` behind
 * `./actions.ts`; this file is the affordance and the copy. Everything it
 * exports besides the component is a pure function, so the four properties
 * worth defending — which verb a status implies, that "nothing changed" does
 * not read as success, that a refused reason code lands on the reason-code
 * input, and that an unknown product disables the action — are testable
 * without driving a dialog.
 */

// Mirrors `lib/tenant-lifecycle-write.ts`'s own NOT_APPLIED sentence, and for
// the same reason `tool-form.tsx` mirrors NOT_SAVED: that module is
// `server-only` and a client component may never import it. Reached only when
// the server action CALL rejects — offline, a 502 at the edge, an expired
// session — which never reaches the seam's own error mapping.
const NOT_APPLIED =
  "That change could not be confirmed. Reload the directory to see the tenant's current status before trying again.";

/** The word the console falls back to when the product returned no status of
 *  its own. Never used in preference to the product's own word. */
const PAST_TENSE: Record<LifecycleVerb, string> = {
  suspend: "suspended",
  unsuspend: "unsuspended",
};

export const VERB_LABEL: Record<LifecycleVerb, string> = {
  suspend: "Suspend",
  unsuspend: "Unsuspend",
};

/**
 * The one status this console reads as "already suspended".
 *
 * `EstateTenant.status` is the PRODUCT's vocabulary and is deliberately not a
 * union (see `lib/tenants.ts`), so this can only ever be a guess about someone
 * else's words. The guess is made in one direction on purpose — see
 * `lifecycleVerbFor`.
 */
const SUSPENDED = "suspended";

/**
 * Which verb a row offers, derived from the product's own status word.
 *
 * Matched case-insensitively because "ACTIVE" and "active" are not different
 * states, the same normalisation `tenantStatusTone` already applies.
 *
 * The asymmetry is the safety property: an UNRECOGNISED status offers Suspend,
 * never Unsuspend. Offering the wrong one of those two is not a symmetric
 * mistake — a wrong Suspend on an active tenant is caught by the operator
 * reading a dialog that says, in the product's own words, what is about to
 * happen, whereas a wrong Unsuspend offered on a status this build has never
 * seen invites an operator to "restore" a tenant that was never suspended, and
 * writes a reversal reason onto an audit row for a suspension that never
 * existed. When in doubt, offer the verb whose confirmation an operator will
 * actually read.
 */
export function lifecycleVerbFor(status: string): LifecycleVerb {
  return status.trim().toLowerCase() === SUSPENDED ? "unsuspend" : "suspend";
}

export interface LifecycleOutcome {
  readonly changed: boolean;
  readonly status: string;
  readonly storesAffected: number;
}

/**
 * What to tell the operator after a write the product accepted.
 *
 * `changed: false` means the product accepted the request and did nothing,
 * because the tenant was already in that state. Rendering that as "suspended
 * successfully" would put an event in the operator's head — and in whatever
 * they write in the incident channel afterwards — that never happened. So the
 * two sentences are deliberately different in their first three words, not
 * merely in a trailing qualifier a reader skims past.
 *
 * The state named is the product's own `status` where it sent one; the
 * console's past tense is only the fallback, for the same reason the table
 * renders `status` verbatim rather than translating it.
 *
 * `storesAffected` is reported only when it is non-zero. A suspension that
 * took three storefronts offline is a bigger event than one that took none,
 * and "0 stores were taken offline" is noise in the one place an operator is
 * scanning for the number that matters.
 */
export function lifecycleOutcomeMessage(
  tenantName: string,
  verb: LifecycleVerb,
  outcome: LifecycleOutcome,
): string {
  const state = outcome.status.trim() !== "" ? outcome.status.trim() : PAST_TENSE[verb];

  if (!outcome.changed) {
    return `Nothing changed — ${tenantName} was already ${state}.`;
  }

  const count = outcome.storesAffected;
  const stores =
    count > 0
      ? ` ${count} ${count === 1 ? "store was" : "stores were"} ${
          verb === "suspend" ? "taken offline" : "returned to service"
        }.`
      : "";
  return `${tenantName} is now ${state}.${stores}`;
}

/**
 * Why the action is unavailable for a product whose reason codes this render
 * does not have.
 *
 * "This render", not "this build" — the codes are fetched per request from the
 * product that owns them (contract §8.8), so the gap now means the product did
 * not answer, or answered with no vocabulary for this verb. That is a
 * different fact from the old one and the copy has to say so: telling an
 * operator the console needs updating, when what actually happened is that
 * mark8ly could not be reached, sends them to the wrong place.
 *
 * Exported so a test asserts the shipped sentence rather than a second copy.
 * The gap is deliberate and visible: see `lib/tenant-lifecycle.ts` for why
 * borrowing another product's codes — or offering a free-text code box — would
 * be the worse failure. Both can write a reason nobody meant onto an audit row
 * that outlives the operator's memory of the change.
 */
export function unknownProductNotice(
  product: string,
  gap: ReasonCodeGap = "unknown",
): string {
  const owner = sourceLabel(product);
  switch (gap) {
    // 503. The product was never reached, so it has not "declined" to publish
    // anything and saying so would send an operator to look for a setting that
    // is not missing. Reloading really is the remedy: the commonest cause is
    // `mark8ly-marketplace-api-admin` being mid-deploy — one replica,
    // `maxSurge: 0`, so its platform-admin surface is down for the length of
    // an image pull on every roll.
    case "unreachable":
      return (
        `${owner} could not be reached, and a lifecycle change must carry one ` +
        `of its reason codes. This is usually brief — ${owner} is most likely ` +
        "mid-deploy. Reload in a moment to try again."
      );
    // 501. The product answered; it has no vocabulary to give. Reloading is
    // pointless and saying "try again" would waste the operator's time, so
    // this is the one case that genuinely points at the product's own admin.
    case "unpublished":
      return (
        `${owner} publishes no reason codes for this change, and a lifecycle ` +
        "change must carry one. Reloading will not help — this needs fixing in " +
        `${owner}, or the change made from its own admin.`
      );
    // Anything else, including a throw that carried no status. Deliberately
    // the original sentence: it names both remedies without claiming which
    // applies, which is the honest thing to say when we do not know.
    default:
      return (
        `${owner} did not supply its reason codes, and a lifecycle ` +
        "change must carry one. Reload to try again, or change it from that product's own admin."
      );
  }
}

/** The dialog's plain statement of what confirming does. Consequential enough
 *  to spell out rather than leave to the button's verb. */
function consequence(tenantName: string, product: string, verb: LifecycleVerb): string {
  const owner = sourceLabel(product);
  return verb === "suspend"
    ? `${tenantName} will be suspended in ${owner}. Its storefronts stop serving customers and its staff lose access until it is unsuspended. ${owner} records this change and who made it.`
    : `${tenantName} will be returned to service in ${owner}. Its storefronts start serving customers again and its staff regain access. ${owner} records this change and who made it.`;
}

export interface TenantLifecycleActionProps {
  tenant: EstateTenant;
  /**
   * Every product's vocabulary this render fetched, keyed by product.
   *
   * Passed in rather than fetched here, and that is the point of the shape: a
   * directory renders one of these per row, and a per-row fetch would ask the
   * same product for the same constant list once per tenant. The page reads it
   * once per product and hands it down.
   *
   * Defaulted to empty so a caller that has none degrades to the visible gap
   * rather than to a menu with nothing in it.
   */
  reasonCodes?: ReasonCodeCatalog;
  /**
   * Why each product has no vocabulary, for the products that failed.
   *
   * Separate from `reasonCodes` rather than folded into it: the catalog is
   * "what a product said", and this is "why it said nothing". A single map
   * holding both would make every reader of the codes handle a failure shape
   * it does not care about.
   *
   * Defaulted to empty so a caller that has none degrades to the cautious
   * `unknown` copy — the sentence this component shipped before the split.
   */
  reasonCodeGaps?: ReasonCodeGaps;
  /**
   * Injected so the render tests can drive every result shape the seam
   * produces. Defaults to the real server action, which is what the directory
   * uses — the same shape `ToolsManager` passes its forms.
   */
  onSubmit?: typeof setTenantLifecycleAction;
}

export function TenantLifecycleAction({
  tenant,
  reasonCodes = NO_REASON_CODES,
  reasonCodeGaps = NO_REASON_CODE_GAPS,
  onSubmit = setTenantLifecycleAction,
}: TenantLifecycleActionProps) {
  const router = useRouter();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The PRODUCT that owns this tenant, taken from the namespaced id rather
  // than trusted from anywhere else — it is the same id the write is aimed at,
  // so the codes offered and the product asked to apply them cannot disagree.
  const { source } = splitTenantId(tenant.id);
  const verb = lifecycleVerbFor(tenant.status);
  const codes = reasonCodesFor(reasonCodes, source, verb);

  // Keyed on the VERB, not just the product. A product may publish suspend
  // codes and not unsuspend ones — §8.8 requires both, so that is a deviation,
  // but the console must render it as the gap it is rather than open a dialog
  // whose one required field has no options.
  if (!hasReasonCodes(reasonCodes, source, verb)) {
    // Disabled, with the reason beside it. A control that silently vanishes
    // for some rows and not others reads as a rendering fault; one that is
    // present and explains itself reads as the deliberate gap it is.
    return (
      // `items-start` for the same reason the enabled branch below has it, and
      // it is load-bearing rather than cosmetic: a flex column defaults to
      // `align-items: stretch`, so without it the disabled Button grows to the
      // full width of the Actions cell. That rendered as a wide empty slab with
      // the word "Suspend" centred in it — reading as a broken layout rather
      // than as a small control that is unavailable, which is the one thing
      // this branch exists to communicate.
      <div className="flex flex-col items-start gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          aria-describedby={`${fieldId}-unavailable`}
        >
          {VERB_LABEL[verb]}
        </Button>
        {/* Width-capped so the sentence wraps into a readable block instead of
            one long line across the widest column in the table. `text-pretty`
            keeps the last line from stranding a single word. */}
        <span
          id={`${fieldId}-unavailable`}
          className="max-w-xs text-pretty text-xs text-muted-foreground"
        >
          {unknownProductNotice(source, reasonCodeGaps[source])}
        </span>
      </div>
    );
  }

  const reset = () => {
    setReasonCode("");
    setReason("");
    setError(null);
  };

  const close = () => {
    setOpen(false);
    reset();
  };

  const fieldError = error?.field === "reasonCode" ? error.message : undefined;
  const formError = error && error.field !== "reasonCode" ? error.message : null;

  const submit = async () => {
    setError(null);
    setPending(true);
    try {
      const result = await onSubmit(tenant.id, verb, reasonCode, reason);
      if (!result.ok) {
        setError({ message: result.message, field: result.field });
        return;
      }
      setNotice(lifecycleOutcomeMessage(tenant.name, verb, result));
      setOpen(false);
      reset();
      // The status column is the product's answer, not the console's — so the
      // directory is re-read rather than patched locally. It also covers the
      // case this surface cannot see: another operator changing the same
      // tenant while this dialog was open.
      router.refresh();
    } catch {
      setError({ message: NOT_APPLIED });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        // Every row renders a control whose visible text is one of two words,
        // so a query by that text alone cannot address a particular tenant's.
        // Same fix `ToolsManager` applies to its per-row Delete.
        aria-label={`${VERB_LABEL[verb]} ${tenant.name}`}
        onClick={() => {
          // Seeded at open time, not mount time: rows are keyed on the
          // namespaced id, so this component is reconciled rather than
          // remounted and an abandoned previous open would otherwise leak in.
          reset();
          setNotice(null);
          setOpen(true);
        }}
      >
        {VERB_LABEL[verb]}
      </Button>

      {notice ? (
        // `role="status"`, not `alert`: the write already succeeded, and an
        // assertive interruption for a completed action is the wrong urgency.
        <span role="status" className="text-xs text-muted-foreground">
          {notice}
        </span>
      ) : null}

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            {/* Names the tenant, in the title, so the dialog is not a generic
                "are you sure" that could belong to any of the rows behind it. */}
            <DialogTitle>
              {VERB_LABEL[verb]} {tenant.name}?
            </DialogTitle>
            <DialogDescription>{consequence(tenant.name, source, verb)}</DialogDescription>
          </DialogHeader>

          {/* The dialog focuses the first focusable element inside its
              content, and the footer is last in DOM order — so what receives
              focus is this form's reason-code select, never the confirm
              button. A confirmation whose destructive control is already
              focused is one keystroke from being a one-click action. */}
          <form
            id={`${fieldId}-form`}
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-reason-code`}>Reason</Label>
              {/* The design system's `Select`, not a native `<select>`: a
                  native one renders an OS-drawn popup that ignores the
                  console's theme, which is what #592 rejected on the
                  promo-code form.
                  
                  Both reasons an earlier comment here gave for staying native
                  were wrong, and are recorded so they are not reinstated:
                  
                  - "the keyboard behaviour is only guaranteed on a native
                    select" — Radix's Select is a composite widget with full
                    keyboard support, and this console already ships one inside
                    a Dialog in `tool-form.tsx`.
                  - "the packaged Select is not drivable in the jsdom tests" —
                    it is. `vitest.setup.ts` stubs Pointer Capture,
                    `scrollIntoView` and `ResizeObserver` globally for exactly
                    this, and `promo-codes-panel.render.test.tsx` drives one by
                    opening the trigger and clicking the option. This file's
                    test does the same.
                  
                  The "Choose a reason…" prompt becomes the placeholder rather
                  than an item — Radix forbids a `SelectItem` with `value=""`,
                  and the prompt was never a choice, which is why the native
                  version had to mark it `disabled`. */}
              <Select
                value={reasonCode}
                disabled={pending}
                onValueChange={setReasonCode}
              >
                <SelectTrigger
                  id={`${fieldId}-reason-code`}
                  className="w-full"
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? `${fieldId}-reason-code-error` : undefined}
                >
                  <SelectValue placeholder="Choose a reason…" />
                </SelectTrigger>
                <SelectContent>
                  {codes.map((code) => (
                    <SelectItem key={code.code} value={code.code}>
                      {code.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldError ? (
                <span
                  id={`${fieldId}-reason-code-error`}
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {fieldError}
                </span>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${fieldId}-reason`}>Notes (optional)</Label>
              <Textarea
                id={`${fieldId}-reason`}
                value={reason}
                rows={3}
                disabled={pending}
                placeholder="Anything the next operator should know."
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            {formError ? (
              <Callout role="alert" variant="destructive">
                <CalloutDescription>{formError}</CalloutDescription>
              </Callout>
            ) : null}
          </form>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={`${fieldId}-form`}
              // Destructive styling for the verb that takes a merchant
              // offline, and NOT for the one that puts them back — a restore
              // dressed as a deletion teaches operators to ignore the colour.
              variant={verb === "suspend" ? "destructive" : "default"}
              // The API refuses a change with no reason code, so an enabled
              // button here would only ever produce a round trip and a
              // refusal.
              disabled={pending || reasonCode === ""}
            >
              {pending ? "Please wait…" : VERB_LABEL[verb]}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
