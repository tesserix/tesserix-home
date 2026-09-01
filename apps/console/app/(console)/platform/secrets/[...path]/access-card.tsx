"use client";

// Required even though this component holds no state of its own.
// @tesserix/web's barrel is itself "use client", and its exports resolve to
// `undefined` when imported into a server component — see
// `secret-detail-view.tsx`'s identical note.

import { type FormEvent, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@tesserix/web";
import type { Grant, SecretStore } from "@/lib/secrets";
import { grantAccessAction, revokeAccessAction } from "./access-actions";

/**
 * The reader-count chip. `count === 0` is the alarm this whole card exists
 * to raise for an OpenBao secret — see `AccessCard`'s doc comment for why a
 * GSM secret never reaches this component at all.
 */
function ReaderCountChip({ count }: { count: number }) {
  if (count === 0) {
    return <Badge variant="warning">No app can read this</Badge>;
  }
  return <Badge variant="success">{count === 1 ? "1 reader" : `${count} readers`}</Badge>;
}

/**
 * The replacement for a GSM secret: a GSM secret's readers are IAM bindings
 * this console cannot see, so there is no reader list to draw here — see
 * `AccessCard`'s doc comment for why an empty one would be the wrong way to
 * say that.
 *
 * Copy is verbatim from the design spec (`docs/superpowers/specs/
 * 2026-08-31-console-secrets-absorption-design.md`, §6): the second
 * paragraph states the distinction on screen deliberately, because it is
 * the clearest statement of it anywhere in the product.
 */
function IamAccessCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Who can read this</CardTitle>
        <CardDescription>
          Governed by <strong>Google Cloud IAM</strong>, not from here. This store has no
          whitelist in <code className="font-mono">tesserix-k8s</code>, so there is nothing for
          the console to propose.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Deliberately not shown as an empty reader list — &ldquo;nothing can read this&rdquo; and
          &ldquo;this tool does not manage who reads this&rdquo; are different facts.
        </p>
      </CardContent>
    </Card>
  );
}

/** One reader row, with a Remove control when the operator can act on it. */
function ReaderRow({
  reader,
  canWrite,
  onRemove,
  pending,
}: {
  reader: Grant;
  canWrite: boolean;
  onRemove: (reader: Grant) => void;
  pending: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="font-mono text-xs">
        {reader.namespace}/{reader.app}
      </span>
      {canWrite && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onRemove(reader)}
        >
          Remove
        </Button>
      )}
    </li>
  );
}

/**
 * The add-a-reader form in the card's footer.
 *
 * Namespace/App/Service account is the whole shape `grantAccessAction`
 * takes — see `access-actions.ts`. `serviceAccount` prefills from `app` as
 * the operator types it (most apps' service account IS their app name), but
 * only until the operator edits `serviceAccount` themselves: `touched`
 * below is the one piece of state that decides which of those two facts is
 * true, and it is the only place this card can go wrong quietly — see the
 * brief and this file's tests for both directions.
 */
function AddReaderForm({
  onGrant,
  pending,
}: {
  onGrant: (input: { namespace: string; app: string; serviceAccount: string }) => void;
  pending: boolean;
}) {
  const [namespace, setNamespace] = useState("");
  const [app, setApp] = useState("");
  const [serviceAccount, setServiceAccount] = useState("");
  // Flips true the moment the operator edits the service-account field
  // directly. Once true, typing in `app` never touches `serviceAccount`
  // again — without this flag, an app-name edit made AFTER a deliberate
  // service-account edit would silently clobber it back to the app name.
  const [serviceAccountTouched, setServiceAccountTouched] = useState(false);

  function handleAppChange(next: string) {
    setApp(next);
    if (!serviceAccountTouched) {
      setServiceAccount(next);
    }
  }

  function handleServiceAccountChange(next: string) {
    setServiceAccountTouched(true);
    setServiceAccount(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedNamespace = namespace.trim();
    const trimmedApp = app.trim();
    const trimmedServiceAccount = serviceAccount.trim();
    // A quiet no-op per the prototype — not an error banner. An operator
    // mid-typing across three fields is not making a mistake that needs
    // calling out; there is simply nothing yet to submit.
    if (!trimmedNamespace || !trimmedApp || !trimmedServiceAccount) {
      return;
    }

    onGrant({ namespace: trimmedNamespace, app: trimmedApp, serviceAccount: trimmedServiceAccount });
    setNamespace("");
    setApp("");
    setServiceAccount("");
    setServiceAccountTouched(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-3">
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Add an app</legend>
        <div className="flex flex-col gap-1">
          <Label htmlFor="access-namespace">Namespace</Label>
          <Input
            id="access-namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
            disabled={pending}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="access-app">App</Label>
          <Input
            id="access-app"
            value={app}
            onChange={(event) => handleAppChange(event.target.value)}
            disabled={pending}
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="access-service-account">Service account</Label>
          <Input
            id="access-service-account"
            value={serviceAccount}
            onChange={(event) => handleServiceAccountChange(event.target.value)}
            disabled={pending}
            spellCheck={false}
          />
        </div>
      </fieldset>
      <Button type="submit" disabled={pending}>
        Propose access
      </Button>
    </form>
  );
}

export interface AccessCardProps {
  store: SecretStore;
  path: string;
  readers: Grant[];
  /** From `page.tsx`'s render-path gate (threaded through
   *  `SecretDetailView`) — the same value that decides whether the Write
   *  tab is offered. Not the security control: `secrets-api` refuses a
   *  `platform`-only caller's grant/revoke outright (403), so this only
   *  decides whether the console offers a control guaranteed to work. */
  canWrite: boolean;
}

/**
 * "Who can read this", now with the add/remove controls this task adds.
 *
 * The hardest property here is a rendering decision, not a data one: a GSM
 * secret's readers are simply not knowable from this console (they are IAM
 * bindings, not a `tesserix-k8s` whitelist), which is a different fact from
 * "nothing can read this". Conflating the two by rendering an empty reader
 * list for GSM would turn "this tool does not manage who reads this" into
 * the exact alarm that's supposed to mean "an operator must act now" — so a
 * GSM secret replaces this card with `IamAccessCard` entirely rather than
 * rendering zero rows within it.
 */
export function AccessCard({ store, readers, canWrite }: AccessCardProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (store !== "openbao") {
    return <IamAccessCard />;
  }

  function refreshAfterChange() {
    // The card re-reads rather than mutating local state — the same reason
    // the inventory's orphan flag is derived rather than remembered: a
    // grant can also be changed from outside this page, so the only source
    // of truth is asking the server again.
    router.refresh();
  }

  function handleGrant(input: { namespace: string; app: string; serviceAccount: string }) {
    setError(null);
    startTransition(async () => {
      const result = await grantAccessAction(input);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      refreshAfterChange();
    });
  }

  function handleRemove(reader: Grant) {
    setError(null);
    startTransition(async () => {
      // NOT a local toggle: a revoke is a change to `tesserix-k8s` on the
      // same route and the same gate as a grant — see `revokeAccessAction`'s
      // own doc comment in `access-actions.ts`.
      const result = await revokeAccessAction(reader.namespace, reader.app);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      refreshAfterChange();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Who can read this</CardTitle>
        <CardDescription>
          Each change here is a change to <code className="font-mono">tesserix-k8s</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ReaderCountChip count={readers.length} />
        {readers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing reads this secret yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {readers.map((reader) => (
              <ReaderRow
                key={`${reader.namespace}/${reader.app}`}
                reader={reader}
                canWrite={canWrite}
                onRemove={handleRemove}
                pending={isPending}
              />
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-3">
        {canWrite ? (
          <>
            <AddReaderForm onGrant={handleGrant} pending={isPending} />
            <p className="text-xs text-muted-foreground">
              <strong>Adding or removing a reader here merges immediately</strong>, because you
              hold <code className="font-mono">rotate-credentials</code>. Both directions are a
              change to <code className="font-mono">tesserix-k8s</code> and both are recorded — a
              removal is not a local toggle.
            </p>
          </>
        ) : (
          // The reason there is no control here is that `secrets-api`
          // refuses a `platform`-only caller's grant/revoke outright (403,
          // no queue) — NOT that this operator "lacks permission to
          // propose": there is no proposal step to lack permission for.
          <p className="text-xs text-muted-foreground">
            <strong>Granting access needs `rotate-credentials`.</strong> Both adding and removing
            a reader change <code className="font-mono">tesserix-k8s</code> immediately, so both
            take the credential verb. Someone holding it can make this change for you.
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
