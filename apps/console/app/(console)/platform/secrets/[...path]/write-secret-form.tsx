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

export interface WriteSecretFormProps {
  readonly store: SecretStore;
  /** Mount-relative, exactly as `fetchSecretDetail`/`writeSecret` take it. */
  readonly path: string;
  /**
   * The version this form's page was rendered from. A positive number means
   * a secret already exists at `path` and this is a ROTATE — that value is
   * sent as `ifVersion` so a write built on stale data is refused (409)
   * instead of silently overwriting whatever another operator wrote in the
   * meantime. `undefined` means there is no secret here yet (a CREATE), and
   * `ifVersion` is omitted entirely — see `writeSecret`'s own doc comment in
   * `lib/secrets-api.ts` for why "omitted" and "0" are the same thing on the
   * wire, and why this form must not try to send one to distinguish them.
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
 * `Store` interface has no `Read` method at all. The copy in this form's
 * hint text says what is true: this is the only moment the value can be
 * retrieved, because nothing in the console can read a stored value back
 * afterwards, whichever way it got in.
 *
 * A rejected earlier design ("do not show it to me", writing a generated
 * value no human ever saw) is not reintroduced here on purpose: the operator
 * creating the secret can always look, a reveal control is one click away,
 * and the guarantee that actually matters is about every moment AFTER
 * creation — which the absent `Store.Read` and the GSM write-blind IAM role
 * already provide regardless of what this form does at creation time.
 */
export function WriteSecretForm({ store, path, currentVersion }: WriteSecretFormProps) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ version: number } | null>(null);
  const [isPending, startTransition] = useTransition();

  const isRotate = currentVersion !== undefined;

  function handleGenerate() {
    setValue(generateSecretValue());
    setGenerated(true);
    setCopied(false);
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

  function handleCopy() {
    if (!value) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
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
      const outcome = await writeSecretAction(store, path, { [trimmedKey]: value }, currentVersion);
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      // The value is dropped from state here, not merely hidden — the
      // success view below has nothing to accidentally render even if a
      // future edit forgets to gate on `result`.
      setResult({ version: outcome.version });
      setKey("");
      setValue("");
      setRevealed(false);
      setGenerated(false);
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
    <form onSubmit={handleSubmit} aria-label={isRotate ? "Rotate secret" : "Create secret"}>
      <div>
        <Label htmlFor="write-secret-key">Key name</Label>
        <Input
          id="write-secret-key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={isPending}
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">Key names are recorded in the audit trail. Values never are.</p>
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
              setGenerated(false);
              setCopied(false);
            }}
            disabled={isPending}
            spellCheck={false}
            placeholder="Paste a value, or generate one"
            autoComplete="off"
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
        <p className="text-xs text-muted-foreground">
          {generated
            ? // The load-bearing sentence spec §7 requires verbatim in intent:
              // this really is the only chance to retrieve this value, because
              // nothing in the console can read a stored value back afterwards.
              "Copy it now if something outside this estate needs it — a payment provider's dashboard, say. Nothing here can read it back afterwards, so this is the only moment it can be retrieved."
            : "Hidden while you type. Nothing in the console can read a stored value back, whichever way this one gets in."}
        </p>
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
