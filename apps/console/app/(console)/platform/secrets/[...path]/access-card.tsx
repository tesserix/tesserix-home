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
import { grantAccessAction, proposeAccessAction, revokeAccessAction } from "./access-actions";

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
 * Namespace/App/Service account is the whole shape BOTH `grantAccessAction`
 * and `proposeAccessAction` take — see `access-actions.ts`. That is why one
 * form serves both modes: the fields do not differ, only which action the
 * card hands them to and what the button promises. `serviceAccount` prefills from `app` as
 * the operator types it (most apps' service account IS their app name), but
 * only until the operator edits `serviceAccount` themselves: `touched`
 * below is the one piece of state that decides which of those two facts is
 * true, and it is the only place this card can go wrong quietly — see the
 * brief and this file's tests for both directions.
 */
function AddReaderForm({
  onGrant,
  pending,
  submitLabel,
}: {
  onGrant: (input: { namespace: string; app: string; serviceAccount: string }) => void;
  pending: boolean;
  /** The two modes submit the SAME three fields to different actions, so the
   *  fields are shared and only the button's promise differs — "Grant
   *  access" for the immediate path, "Propose in a pull request" for the
   *  whitelist path.
   *
   *  The immediate control must NOT say "propose". It was called "Propose
   *  access" before tesserix-home#482, directly above copy stating that the
   *  change "merges immediately" — loose then, false once a real propose
   *  control exists in the other mode, because the card would present two
   *  controls with the one that acts immediately named "Propose". */
  submitLabel: string;
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
        {submitLabel}
      </Button>
    </form>
  );
}

export interface AccessCardProps {
  store: SecretStore;
  readers: Grant[];
  /** From `page.tsx`'s render-path gate (threaded through
   *  `SecretDetailView`) — the same value that decides whether the Write
   *  tab is offered. Not the security control: `secrets-api` refuses a
   *  `platform`-only caller's grant/revoke outright (403), so this only
   *  decides whether the console offers a control guaranteed to work. */
  canWrite: boolean;
  /** From the same render-path gate in `page.tsx` — true when the operator
   *  holds `platform` but NOT `rotate-credentials`, so they cannot grant
   *  immediately but CAN open a pull request against `tesserix-k8s`
   *  (`POST /api/access/whitelist` sits in secrets-api's `authed` group).
   *  Optional and defaulting to false so the absence of the prop can only
   *  ever withhold a control, never offer one. */
  canPropose?: boolean;
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
export function AccessCard({ store, readers, canWrite, canPropose = false }: AccessCardProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The outcome of the most recent proposal, or null when none has been made
  // in this render. Held separately from `error` because a proposal that
  // succeeds still has something to say — a pull request to go and get
  // reviewed, or the fact that the whitelist already granted this.
  const [proposal, setProposal] = useState<
    { status: "proposed"; pullRequest: string } | { status: "unchanged" } | null
  >(null);

  // Reached before either write mode is considered, so the propose control
  // can never appear for a GSM secret: its readers are IAM bindings, and
  // there is no `tesserix-k8s` whitelist to propose against — the copy in
  // `IamAccessCard` says exactly that.
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

  function handlePropose(input: { namespace: string; app: string; serviceAccount: string }) {
    setError(null);
    setProposal(null);
    startTransition(async () => {
      const result = await proposeAccessAction(input);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      // Deliberately NO `router.refresh()` here, unlike `handleGrant`. A
      // proposal changes nothing the reader list is read from — OpenBao holds
      // no new grant until the pull request is merged and ArgoCD syncs it —
      // so re-reading would cost a round trip to show the identical list, and
      // an unchanged list after an apparently successful action reads as a
      // failure.
      setProposal(
        result.status === "proposed"
          ? { status: "proposed", pullRequest: result.pullRequest }
          : { status: "unchanged" },
      );
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
            <AddReaderForm onGrant={handleGrant} pending={isPending} submitLabel="Grant access" />
            <p className="text-xs text-muted-foreground">
              <strong>Adding or removing a reader here merges immediately</strong>, because you
              hold <code className="font-mono">rotate-credentials</code>. Both directions are a
              change to <code className="font-mono">tesserix-k8s</code> and both are recorded — a
              removal is not a local toggle.
            </p>
          </>
        ) : canPropose ? (
          <>
            <AddReaderForm
              onGrant={handlePropose}
              pending={isPending}
              submitLabel="Propose in a pull request"
            />
            <p className="text-xs text-muted-foreground">
              <strong>This opens a pull request against</strong>{" "}
              <code className="font-mono">tesserix-k8s</code>. Nothing here changes the cluster:
              access becomes real when that pull request is merged and ArgoCD syncs it. Granting
              a reader immediately instead needs{" "}
              <code className="font-mono">rotate-credentials</code>, which you do not hold.
            </p>
            {proposal?.status === "proposed" && (
              <p role="status" className="text-xs text-muted-foreground">
                Pull request opened —{" "}
                <a
                  className="underline"
                  href={proposal.pullRequest}
                  target="_blank"
                  rel="noreferrer"
                >
                  review it in tesserix-k8s
                </a>
                . Access becomes real once it is merged and synced.
              </p>
            )}
            {proposal?.status === "unchanged" && (
              // No link, because there is no pull request: secrets-api
              // answers `unchanged` when the whitelist already says this, and
              // omits the URL rather than sending an empty one. This is a
              // success — the requested state already holds.
              <p role="status" className="text-xs text-muted-foreground">
                No pull request was needed — the whitelist already grants this app access.
              </p>
            )}
          </>
        ) : (
          // Reached only by an operator who does not hold `platform` at all —
          // a `platform`-only operator takes the propose branch above. So this
          // names `platform`, not `rotate-credentials`: the previous sentence
          // here named the ONE capability this reader is not missing and said
          // nothing about the one they are, which was true about the immediate
          // grant and useless to the person actually reading it.
          <p className="text-xs text-muted-foreground">
            <strong>
              Changing who can read this needs <code className="font-mono">platform</code>.
            </strong>{" "}
            Both paths start there: proposing a reader in a pull request, and granting one
            immediately, which also takes{" "}
            <code className="font-mono">rotate-credentials</code>. Someone holding these can
            make the change for you.
          </p>
        )}
      </CardFooter>
    </Card>
  );
}
