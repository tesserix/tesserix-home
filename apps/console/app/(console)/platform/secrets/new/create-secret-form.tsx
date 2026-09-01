"use client";

// Required even though @tesserix/web is the only reason: its barrel is
// itself "use client", and its exports resolve to `undefined` when imported
// into a server component — see `secret-detail-view.tsx`'s identical note.
// This component ALSO needs client-only state (store, path, key, value, the
// existence verdict, the write result) for its own reasons, so both
// requirements land on the same file.

import Link from "next/link";
import { type FormEvent, useState, useTransition } from "react";
import { Button, Callout, CalloutDescription, CalloutTitle, Input, Label, labelVariants } from "@tesserix/web";
import { SecretValueField } from "@/components/secrets/secret-value-field";
import { validateSecretPathForCreate } from "@/lib/secret-path";
import type { SecretStore } from "@/lib/secrets";
// `writeSecretAction` is imported from the detail route's action module
// rather than duplicated next to `secretExistsAction`: a create and a rotate
// are the SAME write with and without `ifVersion`, and a second "use server"
// copy would be a second place for the 409 copy and the failure mapping to
// drift from each other.
import { writeSecretAction } from "../[...path]/actions";
import { secretDetailHref } from "../secrets-table";
import { secretExistsAction } from "./actions";

/**
 * A third local copy of the store labels, matching `secrets-table.tsx` and
 * `secret-detail-view.tsx`, which each hold their own. Kept local for the
 * same reason they are: `lib/secrets.ts` is a dependency-free type leaf and
 * has no UI copy in it, and neither of the other two exports its map.
 */
const STORE_LABEL: Record<SecretStore, string> = {
  openbao: "OpenBao",
  gcpsm: "Google Secret Manager",
};

export interface CreateSecretFormProps {
  /** The stores `SECRET_BACKENDS` actually has enabled, from the page. */
  readonly stores: readonly SecretStore[];
  /** Which store to preselect. `null` means "no default" — the operator picks. */
  readonly preferred: SecretStore | null;
}

interface CreateResult {
  readonly store: SecretStore;
  readonly path: string;
  readonly version: number;
}

/**
 * Picks the store this form opens on.
 *
 * With a single enabled store there is no choice to make, so that store wins
 * outright — `preferred` is not even consulted. With both stores enabled,
 * `SecretStore` is exactly `"openbao" | "gcpsm"`, so any non-null `preferred`
 * is necessarily one of `stores`; there is no third value it could name that
 * would need rejecting. `preferred` is still checked for null so "no
 * default" falls through to "" and the operator picks.
 */
function initialStore(stores: readonly SecretStore[], preferred: SecretStore | null): SecretStore | "" {
  if (stores.length === 1) return stores[0];
  if (preferred !== null) return preferred;
  return "";
}

/**
 * The create form: store, path, key name, value, Create secret.
 *
 * Reachable only for a path that holds nothing — `[...path]/page.tsx` turns a
 * 404 into `notFound()`, so `WriteSecretForm`'s create mode has no route of
 * its own. That is why every word here says "created" and never "rotated".
 *
 * TWO DELIBERATE DEPARTURES FROM THE PROTOTYPE (`#screen-create`):
 *
 * 1. The prototype has no store control and its lede says "This writes a
 *    version to OpenBao". It was drawn before spec §6 settled that the
 *    console manages two stores, and production holds far more Google Secret
 *    Manager secrets than OpenBao ones — a create form that could only reach
 *    OpenBao would be the smaller half of the surface. So a store control is
 *    rendered from `stores`. When only ONE store is enabled it is rendered
 *    as static text naming that store, because a one-option select claims
 *    there is a choice to make and there is not.
 *
 * 2. The prototype's path placeholder is `kv/data/mark8ly/stripe`, which is
 *    OpenBao's PHYSICAL KV path. Every path this console sends is
 *    mount-relative (`fetchSecretDetail`, `writeSecret`, and `Grant.
 *    SecretPrefix` since #485), so the placeholder here is mount-relative
 *    and the field is labelled with the `<namespace>/<app>/<name>` shape
 *    `validateSecretPathForCreate` requires — visible before the operator
 *    gets it wrong rather than after submitting.
 *
 * No `name` on any input, for the reason spelled out in full on
 * `WriteSecretForm`: this `<form>` has no `action` of its own, so a `name`d
 * field would serialise the value into the URL on a pre-hydration native GET
 * fallback. `method="post"` closes that path and the absent `name` closes it
 * a second time.
 */
export function CreateSecretForm({ stores, preferred }: CreateSecretFormProps) {
  const [store, setStore] = useState<SecretStore | "">(() => initialStore(stores, preferred));
  const [path, setPath] = useState("");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The path this form refused to write to because something is already
  // there, carried with the store it was checked against so the "rotate it
  // instead" link points at the right secret.
  const [existing, setExisting] = useState<{ store: SecretStore; path: string } | null>(null);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const onlyStore = stores.length === 1 ? stores[0] : null;

  function handleStoreChange(next: SecretStore) {
    setStore(next);
    setError(null);
    // An existence verdict was about the OTHER store's path space. The same
    // path can exist in one store and not the other, so carrying the verdict
    // across the switch would either block a write that is fine or, worse,
    // clear a block that still applies.
    setExisting(null);
    // Re-validate against the store now selected. `validateSecretPathForCreate`
    // applies rules `gcpsm` has and `openbao` does not (Secret Manager's
    // narrower segment character set, and the `--` its path encoding is not
    // allowed to collide with), so a path that passed for one store can fail
    // for the other. Leaving the previous verdict — including a silent
    // "valid", i.e. no message at all — would show the operator a judgement
    // that was made about a different store.
    setPathError(path.trim() === "" ? null : verdictFor(path, next));
  }

  function verdictFor(candidate: string, forStore: SecretStore): string | null {
    const validation = validateSecretPathForCreate(candidate, forStore);
    return validation.ok ? null : validation.message;
  }

  function handlePathChange(next: string) {
    setPath(next);
    setPathError(null);
    setExisting(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setExisting(null);

    if (store === "") {
      setError("Choose a store.");
      return;
    }

    const validation = validateSecretPathForCreate(path, store);
    if (!validation.ok) {
      setPathError(validation.message);
      return;
    }
    setPathError(null);

    // Wording lifted verbatim from `WriteSecretForm` — the situation is
    // identical, and two forms describing the same empty field two different
    // ways is worse than the duplication.
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      setError("Enter a key name.");
      return;
    }
    if (!value) {
      setError("Enter a value, or generate one.");
      return;
    }

    const cleanedPath = validation.cleaned;

    startTransition(async () => {
      // Ask before writing. A create sends no `ifVersion`, which the store
      // reads as "no concurrency check requested" — so writing to a path
      // that already holds a secret would quietly append a version to
      // somebody else's live secret and report it here as a creation.
      //
      // This is a check, not a lock: nothing in secrets-api can reserve a
      // path, and there is no create-if-absent verb to write through, so a
      // secret created by someone else between this call and the write below
      // would still be appended to. That TOCTOU window is real and cannot be
      // closed with the API available here. The check still earns its place
      // — it catches the case that actually happens, an operator typing a
      // path that is already in use — but it is not airtight and must not be
      // described as if it were.
      const existence = await secretExistsAction(store, cleanedPath);
      if (!existence.ok) {
        // "We could not find out" is not permission to proceed. Treating a
        // failed check as `exists: false` would reinstate exactly the
        // overwrite the check exists to prevent.
        setError(existence.message);
        return;
      }
      if (existence.exists) {
        setExisting({ store, path: cleanedPath });
        return;
      }

      // `ifVersion` is OMITTED, and that omission is what makes this a
      // create. Sending a number here would 409 against a path holding
      // nothing, and against a path that does hold something it would behave
      // as a rotate — a write this form's copy tells the operator was a
      // creation. The existence check above is the only thing standing
      // between this call and somebody else's secret.
      const outcome = await writeSecretAction(store, cleanedPath, { [trimmedKey]: value });
      if (!outcome.ok) {
        setError(outcome.message);
        return;
      }
      // The value is dropped from state here, not merely hidden, so the
      // success view below has nothing to accidentally render.
      setResult({ store, path: cleanedPath, version: outcome.version });
      setKey("");
      setValue("");
    });
  }

  function handleCreateAnother() {
    setResult(null);
    setPath("");
    setPathError(null);
    setError(null);
    setExisting(null);
  }

  if (stores.length === 0) {
    return (
      <Callout variant="destructive" role="alert">
        <CalloutDescription>
          No secret store is enabled, so there is nowhere to create a secret.
        </CalloutDescription>
      </Callout>
    );
  }

  if (result) {
    const href = secretDetailHref({ path: result.path, store: result.store });
    return (
      <div className="space-y-4">
        <Callout variant="success" role="status">
          <CalloutTitle>Secret created.</CalloutTitle>
          <CalloutDescription>
            <code>{result.path}</code> in {STORE_LABEL[result.store]} now holds version {result.version}. It
            exists — nothing here is waiting on a review. Nothing can show you the value again; that moment
            already passed.
          </CalloutDescription>
          <Link href={href}>View the secret</Link>
        </Callout>

        {/* Spec §5 step 2's seam — the whitelist proposal, offered as a
         *  clearly optional next step, leading to the detail page whose
         *  access card carries it.
         *
         *  Withheld for `gcpsm` per §6: a Google Secret Manager secret's
         *  readers are IAM bindings, `AddApp`/`RemoveApp` edit the OpenBao
         *  whitelist in `tesserix-k8s` and have no GSM equivalent, and
         *  `AccessCard` already says so on the detail page. Offering a grant
         *  that cannot be proposed would be a second thing this surface
         *  claims and cannot back. */}
        {result.store === "openbao" ? (
          <div>
            <p>Grant an app access to this?</p>
            <p className="text-sm text-muted-foreground">
              If no app is whitelisted for this namespace and app yet, nothing can read it — the secret's own
              page shows who can. Whitelisting is a proposal someone reviews and merges — separate from the
              secret, which already exists.
            </p>
            <Link href={href}>Grant access…</Link>
            <Button type="button" variant="outline" size="sm" onClick={handleCreateAnother}>
              Not now — the secret stays
            </Button>
          </div>
        ) : (
          <div>
            <p className="text-sm text-muted-foreground">
              Who can read a Google Secret Manager secret is governed by Google Cloud IAM, not from here —
              there is nothing for the console to propose.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={handleCreateAnother}>
              Create another secret
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} method="post" aria-label="Create secret">
      <div>
        {onlyStore ? (
          // Static text, not a one-option select: with a single enabled
          // store there is no choice to offer, and a select that cannot
          // change anything reads as one that can.
          //
          // A `<Label htmlFor>` would be INERT here: `<p>` is not a
          // labelable element, so the pairing would do nothing and this
          // field would reach a screen reader with no accessible name at
          // all. `labelVariants()` gives a `<span>` the same styling
          // without claiming an association the markup cannot honour, and
          // `aria-labelledby` is what actually makes the name real —
          // asserted by `getByLabelText` in the test, which can only find
          // this the way a screen reader would.
          <>
            <span id="create-secret-store-label" className={labelVariants()}>
              Store
            </span>
            <p id="create-secret-store" aria-labelledby="create-secret-store-label">
              {STORE_LABEL[onlyStore]}
            </p>
          </>
        ) : (
          <>
            <Label htmlFor="create-secret-store">Store</Label>
            <select
              id="create-secret-store"
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={store}
              disabled={isPending}
              onChange={(event) => handleStoreChange(event.target.value as SecretStore)}
            >
              {/* Present only while nothing is selected, and unselectable, so
               *  "no default" stays visibly unanswered instead of silently
               *  adopting whichever store happens to be first. */}
              {store === "" && (
                <option value="" disabled>
                  Choose a store
                </option>
              )}
              {stores.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {STORE_LABEL[candidate]}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <div>
        <Label htmlFor="create-secret-path">Path</Label>
        <Input
          id="create-secret-path"
          value={path}
          onChange={(event) => handlePathChange(event.target.value)}
          disabled={isPending}
          spellCheck={false}
          placeholder="mark8ly/stripe/webhook"
          autoComplete="off"
          aria-describedby="create-secret-path-hint"
          aria-invalid={pathError !== null}
        />
        <p id="create-secret-path-hint" className="text-xs text-muted-foreground">
          {/* Mount-relative, and shaped `<namespace>/<app>/<name>` — the
           *  prototype's `kv/data/…` example was OpenBao's physical KV path,
           *  which nothing this console sends ever carries. */}
          Shaped <code>&lt;namespace&gt;/&lt;app&gt;/&lt;name&gt;</code>, relative to the store&rsquo;s mount
          — not a physical <code>kv/data/…</code> path.
        </p>
        {pathError && (
          <p role="alert" className="text-xs text-destructive">
            {pathError}
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="create-secret-key">Key name</Label>
        <Input
          id="create-secret-key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={isPending}
          spellCheck={false}
          autoComplete="off"
          aria-describedby="create-secret-key-hint"
        />
        <p id="create-secret-key-hint" className="text-xs text-muted-foreground">
          Key names are recorded in the audit trail. Values never are.
        </p>
      </div>

      <SecretValueField id="create-secret-value" value={value} onChange={setValue} disabled={isPending} />

      {existing && (
        <Callout variant="destructive" role="alert">
          <CalloutTitle>A secret already exists at this path</CalloutTitle>
          <CalloutDescription>
            Nothing was written. Writing here would add a version to that secret rather than create a new
            one — open it and rotate it instead, where the write carries the concurrency check a create
            deliberately has none of.
          </CalloutDescription>
          <Link href={secretDetailHref({ path: existing.path, store: existing.store })}>
            Open {existing.path}
          </Link>
        </Callout>
      )}

      {error && (
        <Callout variant="destructive" role="alert">
          <CalloutDescription>{error}</CalloutDescription>
        </Callout>
      )}

      <Button type="submit" disabled={isPending}>
        Create secret
      </Button>
    </form>
  );
}
