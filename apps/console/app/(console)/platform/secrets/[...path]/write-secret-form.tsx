"use client";

// Required even though @tesserix/web is the only reason: its barrel is
// itself "use client", and its exports resolve to `undefined` when imported
// into a server component — see `secret-detail-view.tsx`'s identical note.
// This component ALSO needs client-only state (the typed/generated value,
// reveal, pending) for its own reasons, so both requirements land on the
// same file.

import { type FormEvent, useState, useTransition } from "react";
import { Copy, CopyCheck, Eye, EyeOff } from "lucide-react";
import { Button, Callout, CalloutDescription, Input, Label } from "@tesserix/web";
import type { SecretStore } from "@/lib/secrets";
import { writeSecretAction } from "./actions";

/**
 * 32 random bytes, base64url-encoded with no padding — spec §7's "Generate
 * produces 32 random bytes" made into a pasteable string.
 *
 * `crypto.getRandomValues` ONLY — never `Math.random`, which is a
 * predictable PRNG, not a cryptographic one. A secret value generated from
 * it is guessable, which defeats the entire point of generating one instead
 * of asking the operator to think of something.
 */
function generateSecretValue(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
 * The write-only value field: hidden by default, with Reveal and Copy
 * controls, and a Generate action. Spec §7 (design doc) settles the shape —
 * both controls operate on the string held in THIS component's own React
 * state, never on anything fetched, because there is nothing to fetch: `GET
 * /api/secrets/*path` returns `SecretDetail` (path, version, key NAMES,
 * timestamps — see `lib/secrets.ts`), never a value, and secrets-api's
 * `Store` interface has no `Read` method at all. The hint text beside the
 * field says what is true, unconditionally (spec §7's own wording, not
 * softened for a pasted value): this is the only moment the value can be
 * retrieved, because nothing in the console can read a stored value back
 * afterwards, whichever way it got in.
 *
 * A rejected earlier design ("do not show it to me", writing a generated
 * value no human ever saw) is not reintroduced here on purpose: the operator
 * creating the secret can always look, a reveal control is one click away,
 * and the guarantee that actually matters is about every moment AFTER
 * creation — which the absent `Store.Read` and the GSM write-blind IAM role
 * already provide regardless of what this form does at creation time.
 *
 * No `name` on either input, and this is deliberate, not an oversight: the
 * `<form>` has no `action`/`method` of its own, so a submit that somehow
 * fires before this component hydrates would fall back to the browser's
 * native default — a GET to the current URL. A `name`d field would then
 * serialise into that URL's query string, landing the secret's value in the
 * address bar and every access log downstream of it. `method="post"` closes
 * that path outright (a native POST fallback still hits the current route
 * with no server action mounted there and simply fails, rather than leaking
 * anything into a URL); the absence of `name` closes it a second, redundant
 * way. Do not add `name` attributes here for a form library's benefit
 * without re-checking this reasoning first.
 */
export function WriteSecretForm({ store, path, currentVersion }: WriteSecretFormProps) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ version: number } | null>(null);
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

  function handleGenerate() {
    setValue(generateSecretValue());
    setCopied(false);
    setCopyError(null);
  }

  /**
   * Toggles the field's visibility by flipping local state — nothing else.
   *
   * Why this reads state instead of fetching: there is no endpoint to fetch
   * a value FROM. `secrets-api`'s `Store` interface has no `Read` method by
   * design ("so no handler can leak one" — spec §6), so a request here
   * would have nowhere to land even if one were written; this is not a
   * shortcut standing in for a future read, it is the only thing reveal
   * could ever do. Do not "improve" this into a fetch — that is precisely
   * the regression the no-network-call test on this handler exists to
   * catch.
   */
  function handleReveal() {
    setRevealed((current) => !current);
  }

  /**
   * `navigator.clipboard` is only present in a secure context (HTTPS, or
   * localhost) — over plain HTTP on any other origin it is `undefined`, so
   * calling `.writeText` on it throws a synchronous `TypeError` before any
   * Promise even exists. And even where the API exists, a denied permission
   * or an unfocused document rejects the Promise it returns. Both cases used
   * to be silent here (a missing guard for the first, a missing `.catch` for
   * the second) — silent in a way that matters more on THIS form than most:
   * copy exists because a stored value can never be read back once written
   * (see this file's header), so a copy that failed without telling the
   * operator is a value that is now unrecoverable both here and wherever it
   * was meant to go.
   */
  function handleCopy() {
    if (!value) return;
    setCopyError(null);
    if (!navigator.clipboard?.writeText) {
      setCopyError("Clipboard access isn't available here. Select the value and copy it manually.");
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => {
        setCopyError("Copy failed. Select the value and copy it manually.");
      },
    );
  }

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
      setResult({ version: outcome.version });
      setIfVersion(outcome.version);
      setKey("");
      setValue("");
      setRevealed(false);
      setCopied(false);
      setCopyError(null);
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
          {isRotate ? "Secret rotated." : "Secret written."} Version {result.version} now exists. Nothing here
          can show you the value again — that moment already passed.
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
        {/* `@tesserix/web`'s `Input` declares `helperText` in its types, but
         *  the shipped runtime bundle never reads it (verified: neither
         *  `helperText` nor `errorText` appears anywhere in
         *  `dist/index.mjs`) — passing it would silently do nothing, not
         *  wire the `aria-describedby` its doc comment implies. Wired by
         *  hand here instead: a real id on the hint, referenced explicitly. */}
        <p id="write-secret-key-hint" className="text-xs text-muted-foreground">
          Key names are recorded in the audit trail. Values never are.
        </p>
      </div>

      <div>
        <Label htmlFor="write-secret-value">Value</Label>
        <div className="flex items-center gap-1">
          <Input
            id="write-secret-value"
            type={revealed ? "text" : "password"}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setCopied(false);
              setCopyError(null);
            }}
            disabled={isPending}
            spellCheck={false}
            placeholder="Paste a value, or generate one"
            autoComplete="off"
            aria-describedby="write-secret-value-hint"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-pressed={revealed}
            aria-label={revealed ? "Hide value" : "Reveal value"}
            onClick={handleReveal}
          >
            {revealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={copied ? "Copied" : "Copy value"}
            onClick={handleCopy}
          >
            {copied ? <CopyCheck aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleGenerate} disabled={isPending}>
            Generate
          </Button>
        </div>
        <p id="write-secret-value-hint" className="text-xs text-muted-foreground">
          {/* Unconditional per spec §7's own wording — a pasted value gets
           *  the identical sentence a generated one does. An earlier version
           *  only said this after Generate was clicked, on the reasoning
           *  that a pasted value "probably" has another copy somewhere
           *  (a password manager); review flagged that "probably" was doing
           *  real work an operator who typed a value on the spot does not
           *  get the benefit of. */}
          Nothing here can read a stored value back afterwards, whichever way it gets in — this is the only
          moment it can be retrieved. Copy it now if something outside this estate needs it, such as a payment
          provider's dashboard.
        </p>
        {copyError && (
          <Callout variant="destructive" role="alert">
            <CalloutDescription>{copyError}</CalloutDescription>
          </Callout>
        )}
      </div>

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
