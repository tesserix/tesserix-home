"use client";

// Required even though @tesserix/web is the only reason: its barrel is
// itself "use client", and its exports resolve to `undefined` when imported
// into a server component — see `secret-detail-view.tsx`'s identical note.
// This component ALSO needs client-only state (key, value, pending, the
// write result) for its own reasons, so both requirements land on the same
// file.

import { type FormEvent, useState, useTransition } from "react";
import { Button, Callout, CalloutDescription, Input, Label } from "@tesserix/web";
import { SecretValueField } from "@/components/secrets/secret-value-field";
import type { SecretStore } from "@/lib/secrets";
import { writeSecretAction } from "./actions";

/**
 * Reduces the raw `currentVersion` prop to the one value this form is ever
 * willing to treat as "a secret already exists here": a POSITIVE number.
 *
 * `parseSecretDetail` types a secret's version as a plain `number`, which
 * admits `0` — and `0` is indistinguishable from "omitted" on the wire (see
 * `writeSecret`'s own doc comment in `lib/secrets-api.ts`). Without this
 * guard, a `0` would still satisfy `!== undefined`, label the button
 * "Rotate secret", and then send `ifVersion: 0` — the exact same request a
 * CREATE sends, i.e. no concurrency check at all, on a write presented to
 * the operator as protected by one. This function is the one place that
 * distinction is enforced, so both the label (`isRotate`) and the argument
 * (`ifVersion`) can never disagree about what counts as a rotate.
 */
function asRotateVersion(currentVersion: number | undefined): number | undefined {
  return currentVersion !== undefined && currentVersion > 0 ? currentVersion : undefined;
}

export interface WriteSecretFormProps {
  readonly store: SecretStore;
  /** Mount-relative, exactly as `fetchSecretDetail`/`writeSecret` take it. */
  readonly path: string;
  /**
   * The version this form's page was rendered from. A positive number means
   * a secret already exists at `path` and this is a ROTATE — that value is
   * sent as `ifVersion` so a write built on stale data is refused (409)
   * instead of silently overwriting whatever another operator wrote in the
   * meantime. `undefined` (or a non-positive number — see
   * {@link asRotateVersion}) means there is no secret here yet (a CREATE),
   * and `ifVersion` is omitted entirely — see `writeSecret`'s own doc
   * comment in `lib/secrets-api.ts` for why "omitted" and "0" are the same
   * thing on the wire, and why this form must not try to send one to
   * distinguish them.
   */
  readonly currentVersion?: number;
}

/**
 * No `name` on either input, and this is deliberate, not an oversight: the
 * `<form>` has no `action` of its own, so a submit that somehow
 * fires before this component hydrates would fall back to the browser's
 * native default — a GET to the current URL. A `name`d field would then
 * serialise into that URL's query string, landing the secret's value in the
 * address bar and every access log downstream of it. `method="post"` closes
 * that path outright (a native POST fallback still hits the current route
 * with no server action mounted there and simply fails, rather than leaking
 * anything into a URL); the absence of `name` closes it a second, redundant
 * way. Do not add `name` attributes here for a form library's benefit
 * without re-checking this reasoning first. `SecretValueField`'s own input
 * carries no `name` either, for the same reason — it renders inside this
 * `<form>`.
 */
export function WriteSecretForm({ store, path, currentVersion }: WriteSecretFormProps) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // `wasRotate` is captured at the moment of THIS write, not read back from
  // `ifVersion`/`isRotate` when the success view renders. `setIfVersion`
  // below (advancing to the version the store just assigned, for the NEXT
  // write) and `setResult` both fire in the same `startTransition` callback,
  // and React batches them — so a render reading live `isRotate` after both
  // updates always sees the ADVANCED value, which is truthy for a create
  // too (the store assigns a real positive version on a create, same as a
  // rotate). Without capturing it here, an operator who just created a
  // secret would be told "Secret rotated." That is Finding 4 exactly:
  // advancing `ifVersion` for the next write is correct; reading it back as
  // a description of the write that just happened is not.
  const [result, setResult] = useState<{ version: number; wasRotate: boolean } | null>(null);
  // Seeded from the prop once, then OWNED by this component: a successful
  // write returns the version the store actually assigned, and every
  // subsequent write in the same session (via "Write another version") must
  // check against THAT version, not the one this page happened to render
  // with. Without this, a second write after a successful rotate would keep
  // sending the now-stale prop version forever and 409 every time — the
  // bug this state exists to close. See `handleSubmit`'s success branch for
  // where it is advanced.
  const [ifVersion, setIfVersion] = useState<number | undefined>(asRotateVersion(currentVersion));
  const [isPending, startTransition] = useTransition();

  const isRotate = ifVersion !== undefined;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmedKey = key.trim();
    if (!trimmedKey) {
      setError("Enter a key name.");
      return;
    }
    if (!value) {
      setError("Enter a value, or generate one.");
      return;
    }

    startTransition(async () => {
      const outcome = await writeSecretAction(store, path, { [trimmedKey]: value }, ifVersion);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      // The value is dropped from state here, not merely hidden — the
      // success view below has nothing to accidentally render even if a
      // future edit forgets to gate on `result`. `ifVersion` is advanced to
      // the version the store just assigned, so a second write in this same
      // session (via "Write another version") checks against what is
      // actually there now, not the version this page was rendered from.
      //
      // Routed through `asRotateVersion`, same as the initial seed below —
      // not because a write can legitimately report a non-positive version
      // today (OpenBao KV v2 assigns versions starting at 1 and only
      // increments; a `0` here would mean the store itself broke its own
      // contract), but because that guarantee lives in another system, not
      // in this component. Finding 3's bug was exactly this shape: correct
      // until something upstream handed this component a `0`. Guarding both
      // the seed and the advancement means `isRotate` can never disagree
      // with what was actually sent, regardless of what a future caller
      // (real or a test double) hands back.
      setResult({ version: outcome.version, wasRotate: isRotate });
      setIfVersion(asRotateVersion(outcome.version));
      setKey("");
      setValue("");
    });
  }

  function handleWriteAnother() {
    setResult(null);
    setError(null);
  }

  if (result) {
    return (
      <Callout variant="success" role="status">
        <CalloutDescription>
          {/* `result.wasRotate`, not `isRotate` — see `result`'s state
           *  comment above for why the live value is the wrong thing to
           *  read here. */}
          {result.wasRotate ? "Secret rotated." : "Secret written."} Version {result.version} now exists.
          Nothing here can show you the value again — that moment already passed.
        </CalloutDescription>
        <Button type="button" variant="outline" size="sm" onClick={handleWriteAnother}>
          Write another version
        </Button>
      </Callout>
    );
  }

  return (
    <form onSubmit={handleSubmit} method="post" aria-label={isRotate ? "Rotate secret" : "Create secret"}>
      <div>
        <Label htmlFor="write-secret-key">Key name</Label>
        <Input
          id="write-secret-key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={isPending}
          spellCheck={false}
          aria-describedby="write-secret-key-hint"
        />
        <p id="write-secret-key-hint" className="text-xs text-muted-foreground">
          Key names are recorded in the audit trail. Values never are.
        </p>
      </div>

      <SecretValueField id="write-secret-value" value={value} onChange={setValue} disabled={isPending} />

      {error && (
        <Callout variant="destructive" role="alert">
          <CalloutDescription>{error}</CalloutDescription>
        </Callout>
      )}

      <Button type="submit" disabled={isPending}>
        {isRotate ? "Rotate secret" : "Create secret"}
      </Button>
    </form>
  );
}
