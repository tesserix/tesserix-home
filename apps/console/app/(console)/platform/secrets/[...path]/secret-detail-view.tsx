"use client";

// Required even though this component uses no hooks. @tesserix/web's barrel
// is itself "use client", and its exports resolve to `undefined` when
// imported into a server component — see components/kit/page-header.tsx's
// identical note. `page.tsx` stays a server component (the estate read has
// to happen there), so all `@tesserix/web` rendering lives here instead.

import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
import { DetailLayout } from "@/components/kit/detail-layout";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { Grant, SecretDetail, SecretStore, SecretVersion } from "@/lib/secrets";
import { AccessCard } from "./access-card";
import { DestroySecret } from "./destroy-secret";
import { RestoreVersionControl } from "./restore-version";
import { WriteSecretForm } from "./write-secret-form";

const STORE_LABEL: Record<SecretStore, string> = {
  openbao: "OpenBao",
  gcpsm: "Google Secret Manager",
};

/**
 * The badge distinguishing a version's OpenBao KV v2 lifecycle state.
 *
 * `destroyed` and `deleted` are different facts, not two names for one: a
 * deleted version is soft-deleted and can be restored, a destroyed version is
 * gone permanently. A later task adds restore, and an operator reading this
 * table needs to see which versions restore is even possible for — so
 * `destroyed` is checked first and renders its own label rather than falling
 * through to "Deleted": KV v2's only path to `destroyed` passes through
 * `deleted` first, so a version that is both must read as the more final of
 * the two facts, not the earlier one. The ordering matters HERE because each
 * branch renders different content. `RestoreVersionControl` makes the same
 * destroyed-versus-deleted distinction, but its two guards both render
 * nothing, so what matters there is that its `destroyed` guard EXISTS, not
 * where it sits — see its own doc comment, and do not read this one as
 * saying the two components share an ordering requirement.
 */
export function VersionStatusBadge({ version }: { version: SecretVersion }) {
  if (version.destroyed) {
    return <Badge variant="destructive">Destroyed</Badge>;
  }
  if (version.deleted) {
    return <Badge variant="warning">Deleted</Badge>;
  }
  return <Badge variant="success">Active</Badge>;
}

/**
 * The Versions tab. Shown to every viewer regardless of `canWrite` — it is
 * only the Restore control inside a row that is gated, the same way
 * `AccessCard` shows its reader list to everyone and gates just the
 * add/remove buttons.
 *
 * The Actions column header is rendered unconditionally so the table keeps
 * one shape for every operator; which rows put a control in it is
 * `RestoreVersionControl`'s decision, not this table's.
 */
function VersionHistoryTable({
  store,
  path,
  versions,
  canWrite,
}: {
  store: SecretStore;
  path: string;
  versions: SecretVersion[];
  canWrite: boolean;
}) {
  if (versions.length === 0) {
    return <p className="text-sm text-muted-foreground">No version history recorded.</p>;
  }
  return (
    <Table aria-label="Version history">
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map((version) => (
          <TableRow key={version.version}>
            <TableCell>{version.version}</TableCell>
            <TableCell>
              {version.createdAt ? new Date(version.createdAt).toLocaleString() : "Not recorded"}
            </TableCell>
            <TableCell>
              <VersionStatusBadge version={version} />
            </TableCell>
            <TableCell>
              <RestoreVersionControl
                store={store}
                path={path}
                version={version}
                canWrite={canWrite}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export interface SecretDetailViewProps {
  store: SecretStore;
  path: string;
  detail: SecretDetail | null;
  versions: SecretVersion[];
  /** Every grant covering this secret, already filtered by `page.tsx` via
   *  `readersFor` — `[]` for a GSM secret (see the comment at that call
   *  site), which `AccessCard` never renders as an empty reader list. */
  readers: Grant[];
  state: SurfaceState;
  /** From `page.tsx`'s render-path gate — see the comment there. Not the
   *  security control: it only decides which controls are offered — the
   *  Write and Delete tabs, and the Versions tab's per-row Restore. */
  canWrite: boolean;
}

/**
 * The client half of the secret detail surface — everything that touches
 * `@tesserix/web`. `page.tsx` (the server component) fetches and decides
 * `state`; this component only renders what it is handed.
 *
 * `detail === null` (the error/empty states) renders the same empty
 * `DetailLayout` shape `tickets/[id]/page.tsx` and
 * `crm/[organisation]/page.tsx` use for the same reason: `state` takes over
 * the whole body whenever it isn't `"ready"`, so summary/tabs are empty
 * rather than partially populated.
 */
export function SecretDetailView({
  store,
  path,
  detail,
  versions,
  readers,
  state,
  canWrite,
}: SecretDetailViewProps) {
  if (!detail) {
    return (
      <DetailLayout
        title="Secret"
        breadcrumbs={[
          { label: "Secrets", href: "/platform/secrets" },
          { label: "Secret" },
        ]}
        summary={[]}
        tabs={[]}
        state={state}
      />
    );
  }

  return (
    <DetailLayout
      title={detail.path}
      breadcrumbs={[
        { label: "Secrets", href: "/platform/secrets" },
        { label: detail.path },
      ]}
      summary={[
        { label: "Store", value: STORE_LABEL[store] },
        { label: "Path", value: <span className="font-mono text-xs">{path}</span> },
        { label: "Current version", value: String(detail.version) },
        {
          // `keys` is a list of key NAMES — never a value. See
          // `SecretDetail`'s doc comment in `lib/secrets.ts`.
          label: "Keys",
          value:
            detail.keys.length === 0 ? (
              "No keys"
            ) : (
              <ul className="list-disc pl-4">
                {detail.keys.map((key) => (
                  <li key={key} className="font-mono text-xs">
                    {key}
                  </li>
                ))}
              </ul>
            ),
        },
        ...(detail.createdAt
          ? [{ label: "Created", value: new Date(detail.createdAt).toLocaleString() }]
          : []),
        ...(detail.updatedAt
          ? [{ label: "Updated", value: new Date(detail.updatedAt).toLocaleString() }]
          : []),
      ]}
      tabs={[
        {
          id: "versions",
          label: "Versions",
          content: (
            <VersionHistoryTable
              store={store}
              path={path}
              versions={versions}
              canWrite={canWrite}
            />
          ),
        },
        // The tab itself is shown to every viewer — unlike Write below,
        // which is offered only to an operator who can write at all. Access
        // has readers worth seeing regardless of `canWrite`; it is the
        // add/remove controls INSIDE `AccessCard` that `canWrite` gates, for
        // the same reason `AccessCard`'s own doc comment gives: the refusal
        // is copy the card renders itself, not an absent tab.
        {
          id: "access",
          label: "Access",
          content: (
            <AccessCard store={store} readers={readers} canWrite={canWrite} />
          ),
        },
        // Offered only to an operator whose session holds both `platform`
        // and `rotate-credentials` (see `canWrite`'s doc comment above). A
        // `platform`-only operator never sees this tab at all — the summary
        // and Versions tab above render exactly the same either way.
        ...(canWrite
          ? [
              {
                id: "write",
                label: "Write",
                content: (
                  <WriteSecretForm store={store} path={path} currentVersion={detail.version} />
                ),
              },
              // Its own tab, not a section tacked onto Write: a version write
              // and a delete/destroy are different mental models (adding a
              // version vs. removing the secret entirely), and `DestroySecret`
              // is the one place in this phase using the destructive button
              // style — keeping it off the Write tab means that style never
              // shows up beside the everyday "Rotate secret"/"Create secret"
              // button. Same `canWrite` gate as Write: `secrets-api` refuses
              // a `platform`-only caller's delete/destroy outright (403), so
              // offering the tab to them would be a control they cannot use.
              {
                id: "delete",
                label: "Delete",
                content: <DestroySecret store={store} path={path} canWrite={canWrite} />,
              },
            ]
          : []),
      ]}
      state={state}
    />
  );
}
