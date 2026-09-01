"use client";

// Required even though this component holds no state of its own.
// @tesserix/web's barrel is itself "use client", and its exports resolve to
// `undefined` when imported into a server component — see
// `secret-detail-view.tsx`'s identical note.

import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@tesserix/web";
import type { Grant, SecretStore } from "@/lib/secrets";

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

export interface AccessCardProps {
  store: SecretStore;
  path: string;
  readers: Grant[];
}

/**
 * "Who can read this" — read-only in this task. Add/remove controls land in
 * a later task; this component takes no `canWrite` because it has no
 * control to gate yet.
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
// `path` is part of the interface (a later task's add-reader control needs
// it) but this read-only version has nothing to do with it yet — left
// undestructured rather than bound to an unused name.
export function AccessCard(props: AccessCardProps) {
  const { store, readers } = props;
  if (store !== "openbao") {
    return <IamAccessCard />;
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
          <ul className="flex flex-col gap-1">
            {readers.map((reader) => (
              <li key={`${reader.namespace}/${reader.app}`} className="font-mono text-xs">
                {reader.namespace}/{reader.app}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
