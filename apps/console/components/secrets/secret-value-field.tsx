"use client";

// Required even though @tesserix/web is the only reason: its barrel is
// itself "use client", and its exports resolve to `undefined` when imported
// into a server component — see `secret-detail-view.tsx`'s identical note.
// This component ALSO needs client-only state (revealed, copied, copyError)
// for its own reasons, so both requirements land on the same file.

import { useState } from "react";
import { Copy, CopyCheck, Eye, EyeOff } from "lucide-react";
import { Button, Callout, CalloutDescription, Input, Label } from "@tesserix/web";

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

export interface SecretValueFieldProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly disabled?: boolean;
  /** Default `"secret-value"`, so two instances on one page could differ. */
  readonly id?: string;
}

/**
 * The write-only value field: hidden by default, with Reveal and Copy
 * controls, and a Generate action. Spec §7 (design doc) settles the shape —
 * both controls operate on the string held in `value`/`onChange`, never on
 * anything fetched, because there is nothing to fetch: `GET
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
 * already provide regardless of what this field does at creation time.
 *
 * The value reaches the parent through `onChange` only — this component
 * holds no copy of it in its own state, so the parent stays the single
 * owner of the value.
 */
export function SecretValueField({ value, onChange, disabled, id = "secret-value" }: SecretValueFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  const hintId = `${id}-hint`;

  function handleGenerate() {
    onChange(generateSecretValue());
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
   * the second) — silent in a way that matters more on THIS field than most:
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

  return (
    <div>
      <Label htmlFor={id}>Value</Label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setCopied(false);
            setCopyError(null);
          }}
          disabled={disabled}
          spellCheck={false}
          placeholder="Paste a value, or generate one"
          autoComplete="off"
          aria-describedby={hintId}
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
        <Button type="button" variant="ghost" size="icon-sm" aria-label={copied ? "Copied" : "Copy value"} onClick={handleCopy}>
          {copied ? <CopyCheck aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={handleGenerate} disabled={disabled}>
          Generate
        </Button>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {/* `@tesserix/web`'s `Input` declares `helperText` in its types, but
         *  the shipped runtime bundle never reads it (verified: neither
         *  `helperText` nor `errorText` appears anywhere in
         *  `dist/index.mjs`) — passing it would silently do nothing, not
         *  wire the `aria-describedby` its doc comment implies. Wired by
         *  hand here instead: a real id on the hint, referenced explicitly.
         *
         *  Unconditional per spec §7's own wording — a pasted value gets
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
  );
}
