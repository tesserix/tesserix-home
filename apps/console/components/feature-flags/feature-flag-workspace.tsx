"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Flag, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@tesserix/web";
import {
  featureFlagChangeSchema,
  unresolvedCommand,
  type FeatureFlag,
  type FeatureFlagChange,
  type FeatureFlagCommand,
  type FeatureFlagSnapshot,
  type FeatureFlagWriteResult,
} from "@/lib/feature-flags-contract";

import { CommandRecovery, type RecoveryAction } from "./command-recovery";

type Props = {
  onRecoverAction?: RecoveryAction;
  snapshot: FeatureFlagSnapshot | null;
  commands: FeatureFlagCommand[] | null;
  error?: string;
  canManage: boolean;
  operatorSubject: string;
  onChangeAction: (
    change: FeatureFlagChange,
  ) => Promise<FeatureFlagWriteResult>;
};
type Selection = {
  flag: FeatureFlag;
  enabled: boolean;
  revision: string;
  impact: string[];
  focus: HTMLButtonElement;
};

export function FeatureFlagWorkspace({
  snapshot,
  commands,
  error,
  canManage,
  operatorSubject,
  onChangeAction,
  onRecoverAction,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("All");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [notice, setNotice] = useState<FeatureFlagWriteResult | null>(null);
  const [refreshing, refresh] = useTransition();
  const unresolved = commands?.some(unresolvedCommand) ?? false;
  const paused = unresolved || commands === null || refreshing;
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [router]);
  const flags = snapshot?.flags ?? [];
  const names = new Map(flags.map((flag) => [flag.key, flag.title]));
  const groups = ["All", ...new Set(flags.map((flag) => flag.group))];
  const visible = flags.filter(
    (flag) =>
      (group === "All" || flag.group === group) &&
      `${flag.title} ${flag.description} ${flag.key}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  function settled(result: FeatureFlagWriteResult) {
    setNotice(result);
    if (result.ok) setSelection(null);
    refresh(() => router.refresh());
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border bg-card p-5">
        <div className="flex gap-3">
          <span className="rounded-lg bg-primary/10 p-2 text-primary">
            <Flag className="size-5" aria-hidden="true" />
          </span>
          <div>
            <p className="font-semibold">Helivanta release controls</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Production · all Helivanta tenants
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          disabled={refreshing}
          onClick={() => refresh(() => router.refresh())}
        >
          <RefreshCw className="mr-2 size-4" aria-hidden="true" />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
        <p className="w-full text-sm text-muted-foreground">
          These flags control feature availability. They do not assign staff
          permissions. Active workspaces pick up changes through their normal
          refresh cycle.
        </p>
      </div>
      {!canManage && (
        <p className="rounded-lg border bg-muted/40 p-4 text-sm">
          <LockKeyhole className="mr-2 inline size-4" aria-hidden="true" />
          Read-only access. Changes require the manage-feature-flags capability
          in addition to platform access.
        </p>
      )}
      {unresolved && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
        >
          Editing paused — a change is unresolved. Current provider values
          remain visible; new changes are blocked until its outcome is
          confirmed.
        </p>
      )}
      {notice && !selection && (
        <p role="status" className="rounded-lg border bg-muted/30 p-4 text-sm">
          {notice.message}
        </p>
      )}
      {error && (
        <section className="rounded-xl border p-6" role="alert">
          <h2 className="font-semibold">
            Feature availability could not be verified
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Controls are unavailable. This does not mean that all features are
            disabled.
          </p>
        </section>
      )}
      {snapshot && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric
              title="Available in Helivanta"
              value={flags.filter((flag) => flag.available).length}
              detail="Released, enabled and prerequisites available"
            />
            <Metric
              title="Provider enabled"
              value={flags.filter((flag) => flag.enabled).length}
              detail="Desired values stored in GrowthBook"
            />
            <Metric
              title="Release locked"
              value={flags.filter((flag) => !flag.eligible).length}
              detail="Cannot be enabled until an approved release"
            />
          </div>
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium" htmlFor="feature-search">
              Find a feature
            </label>
            <input
              id="feature-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Staff, PharmaConnect or a flag key"
              className="h-10 rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Feature groups"
            >
              {groups.map((name) => (
                <Button
                  key={name}
                  size="sm"
                  variant={group === name ? "default" : "outline"}
                  aria-pressed={group === name}
                  onClick={() => setGroup(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-5 py-3">
              <h2 className="font-semibold">
                {group === "All" ? "All feature flags" : group}
              </h2>
              <span className="text-xs text-muted-foreground">
                {visible.length} of {flags.length} · release policy{" "}
                {snapshot.policy_version}
              </span>
            </div>
            {visible.length === 0 && (
              <p className="p-6 text-sm text-muted-foreground">
                No flags match this filter.
              </p>
            )}
            {visible.map((flag) => {
              const disabled =
                !canManage ||
                paused ||
                (!flag.enabled &&
                  (!flag.eligible || flag.blocked_by.length > 0));
              const status = flag.available
                ? "Available"
                : !flag.eligible
                  ? "Release locked"
                  : flag.enabled
                    ? "Prerequisites unavailable"
                    : "Off";
              return (
                <article
                  key={flag.key}
                  className="flex items-start justify-between gap-5 border-b p-5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{flag.title}</h3>
                      <span
                        className={
                          flag.available
                            ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
                            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                        }
                      >
                        {status}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {flag.group}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {flag.description}
                    </p>
                    <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
                      helivanta.release.{flag.key}
                    </p>
                    {flag.dependencies.length > 0 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Requires:{" "}
                        {flag.dependencies
                          .map((key) => names.get(key) ?? key)
                          .join(", ")}
                      </p>
                    )}
                    {flag.blocked_by.length > 0 && (
                      <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                        Unavailable prerequisites:{" "}
                        {flag.blocked_by
                          .map((key) => names.get(key) ?? key)
                          .join(", ")}
                      </p>
                    )}
                    {!flag.eligible && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        <LockKeyhole
                          className="mr-1 inline size-3"
                          aria-hidden="true"
                        />
                        This feature is outside the approved release. A provider
                        toggle cannot release it.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flag.enabled}
                    aria-label={`${flag.enabled ? "Disable" : "Enable"} ${flag.title}`}
                    disabled={disabled}
                    onClick={(event) =>
                      setSelection({
                        flag,
                        enabled: !flag.enabled,
                        revision: snapshot.revision,
                        impact: (flag.enabled
                          ? flag.impact_when_disabled
                          : flag.impact_when_enabled
                        ).map((key) => names.get(key) ?? key),
                        focus: event.currentTarget,
                      })
                    }
                    className={
                      flag.enabled
                        ? "mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-primary p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                        : "mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-muted-foreground/30 p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40"
                    }
                  >
                    <span
                      className={
                        flag.enabled
                          ? "size-5 translate-x-5 rounded-full bg-background shadow transition-transform"
                          : "size-5 rounded-full bg-background shadow transition-transform"
                      }
                    />
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}
      <section className="rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b p-5">
          <ShieldCheck
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="font-semibold">Recent command history</h2>
          <span className="ml-auto text-xs text-muted-foreground">
            Latest 20 requests · UTC
          </span>
        </div>
        {commands === null ? (
          <p role="alert" className="p-5 text-sm text-muted-foreground">
            Command history is unavailable. Editing is paused.
          </p>
        ) : commands.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            No changes have been requested yet.
          </p>
        ) : (
          <ol>
            {commands.map((command) => (
              <li key={command.id} className="border-b p-5 last:border-b-0">
                <div className="flex flex-wrap justify-between gap-2">
                  <p className="text-sm font-medium">
                    {command.enabled ? "Enable" : "Disable"}{" "}
                    {names.get(command.key) ?? command.key}
                  </p>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                    {command.state === "in_doubt"
                      ? "Outcome unknown"
                      : command.state.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {command.reason}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Requested by{" "}
                  {command.actor === operatorSubject
                    ? "you"
                    : "a platform operator"}{" "}
                  ·{" "}
                  {new Intl.DateTimeFormat("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "UTC",
                  }).format(new Date(command.created_at))}{" "}
                  UTC
                </p>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {command.id} ·{" "}
                  {command.code || "Awaiting provider confirmation"}
                </p>
                {canManage && onRecoverAction && (
                  <CommandRecovery
                    command={command}
                    requester={command.actor === operatorSubject}
                    onRecover={onRecoverAction}
                    onResult={settled}
                  />
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      {selection && (
        <ChangeDialog
          selection={selection}
          disabled={
            !canManage || paused || snapshot?.revision !== selection.revision
          }
          onClose={() => setSelection(null)}
          onChangeAction={onChangeAction}
          onResult={settled}
        />
      )}
    </div>
  );
}

function Metric({
  title,
  value,
  detail,
}: {
  title: string;
  value: number;
  detail: string;
}) {
  return (
    <section className="rounded-xl border bg-card p-5">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{detail}</p>
    </section>
  );
}

function ChangeDialog({
  selection,
  disabled,
  onClose,
  onChangeAction,
  onResult,
}: {
  selection: Selection;
  disabled: boolean;
  onClose: () => void;
  onChangeAction: Props["onChangeAction"];
  onResult: (result: FeatureFlagWriteResult) => void;
}) {
  const id = useId();
  const focusTarget = selection.focus;
  useEffect(
    () => () => {
      queueMicrotask(() => {
        if (focusTarget.isConnected) focusTarget.focus();
      });
    },
    [focusTarget],
  );
  const [requestKey] = useState(() => crypto.randomUUID());
  const attempt = useRef<FeatureFlagChange | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [state, action, pending] = useActionState<
    FeatureFlagWriteResult,
    FormData
  >(
    async (_previous, data) => {
      const parsed = featureFlagChangeSchema.safeParse(
        attempt.current ?? {
          request_key: requestKey,
          key: selection.flag.key,
          enabled: selection.enabled,
          expected_revision: selection.revision,
          reason: data.get("reason"),
        },
      );
      if (!parsed.success)
        return {
          ok: false,
          message: parsed.error.issues[0]?.message ?? "Review the reason.",
        };
      attempt.current ??= parsed.data;
      setFrozen(true);
      let result: FeatureFlagWriteResult;
      try {
        result = await onChangeAction(attempt.current);
      } catch {
        result = {
          ok: false,
          message:
            "The change could not be confirmed. Refresh the flags and command history before trying again.",
        };
      }
      onResult(result);
      return result;
    },
    { ok: false, message: "" },
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {selection.enabled ? "Enable" : "Disable"} {selection.flag.title}?
          </DialogTitle>
          <DialogDescription>
            This changes release availability for every Helivanta tenant in
            production. Existing permissions remain required.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-5">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">
              {selection.impact.length > 0
                ? selection.enabled
                  ? "Dependent features that will resume"
                  : "Dependent features that will become unavailable"
                : "No other feature availability changes"}
            </p>
            {selection.impact.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {selection.impact.map((title) => (
                  <li key={title}>{title}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Dependent desired values are preserved. Their effective
              availability follows their prerequisites.
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor={`${id}-reason`}>
              Reason for this change
            </label>
            <textarea
              id={`${id}-reason`}
              name="reason"
              required
              minLength={8}
              maxLength={500}
              rows={3}
              disabled={pending || disabled || frozen}
              placeholder="Explain the release decision or incident reference"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              8–500 characters. Keep patient details and credentials out of this
              record.
            </p>
          </div>
          {disabled && (
            <p
              role="alert"
              className="text-sm text-amber-800 dark:text-amber-200"
            >
              The current flags or management state changed. Close this dialog
              and review the refreshed view.
            </p>
          )}
          {state.message && (
            <p role="alert" className="text-sm text-muted-foreground">
              {state.message}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending || disabled || state.command?.state === "failed"
              }
            >
              {pending
                ? "Confirming…"
                : frozen
                  ? "Retry same request"
                  : selection.enabled
                    ? "Confirm enable"
                    : "Confirm disable"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
