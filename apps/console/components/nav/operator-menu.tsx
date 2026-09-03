"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronsUpDown } from "lucide-react";
import { consolePath } from "@tesserix/console-core";
import { RISK_CAPABILITIES, SURFACE_CAPABILITIES } from "@tesserix/platform-auth";

/**
 * First letters of the first two whitespace-separated words of `name`,
 * uppercased. Falls back to the first letter of `email` when there is no
 * name, and to an empty string when neither yields anything — never an
 * empty circle with stray characters.
 */
export function initialsFor(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join("");
  }
  const trimmedEmail = email.trim();
  return trimmedEmail ? trimmedEmail[0]!.toUpperCase() : "";
}

export interface OperatorMenuProps {
  readonly name: string;
  readonly email: string;
  readonly capabilities: readonly string[];
  /** False under the legacy provider, where sessions carry no roles and a
   *  capability list would be a misleading empty set. */
  readonly showCapabilities: boolean;
}

/**
 * The signed-in operator's identity, held capabilities and sign-out link.
 *
 * Never touches auth itself — the session is read server-side and handed
 * down as props, so this component stays a pure presentational client
 * island. Open/close behaviour (outside click + Escape) is modeled on
 * `RailSwitcher` in `./sidebar.tsx`. The panel itself follows the
 * disclosure pattern used by `NotificationBell` — `role="dialog"`, not
 * `role="menu"` — because its content is a link plus static information,
 * not a set of `role="menuitem"` commands with roving-tabindex/arrow-key
 * navigation. `@tesserix/web` has no Popover export, hence the hand-rolled
 * panel.
 */
export function OperatorMenu({
  name,
  email,
  capabilities,
  showCapabilities,
}: OperatorMenuProps) {
  const [open, setOpen] = useState(false);

  // Counted from the vocabulary's own lists rather than a local split:
  // `SURFACE_CAPABILITIES` and `RISK_CAPABILITIES` are exported for exactly
  // this ("so a renderer can reason about surfaces without hard-coding the
  // list"), and a second copy here would drift the day a capability is added.
  const held = new Set(capabilities);
  const surfaceCount = SURFACE_CAPABILITIES.filter((c) => held.has(c)).length;
  const actionCount = RISK_CAPABILITIES.filter((c) => held.has(c)).length;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocumentPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocumentPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocumentPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const displayName = name || email;
  const initials = initialsFor(name, email);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        {initials ? (
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-foreground"
          >
            {initials}
          </span>
        ) : null}
        <span className="hidden truncate text-[13px] font-medium text-foreground sm:inline">
          {displayName}
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Operator menu"
          className="absolute right-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
        >
          <div className="border-b border-border px-2.5 py-2">
            <p className="truncate text-[13px] text-muted-foreground">{email}</p>
          </div>

          <div className="border-b border-border px-2.5 py-2">
            {/* A COUNT AND A LINK, not the list.
                
                This used to render all twelve capabilities as raw slugs, in
                alphabetical order, with surfaces and verbs interleaved — a
                machine vocabulary shown to a person, in a dropdown that is
                otherwise identity and sign-out. It answered #267's "let an
                operator see their own capabilities" literally and unhelpfully.

                The count is what a menu can usefully say; /platform/profile
                says the rest, grouped, and reads the LIVE store rather than
                this cookie — which matters, because the cookie is exactly what
                goes stale. Hence no lag caveat here any more: the caveat now
                lives beside the answer it qualifies. */}
            {showCapabilities ? (
              <p className="text-[13px] text-muted-foreground">
                {surfaceCount} {surfaceCount === 1 ? "surface" : "surfaces"} ·{" "}
                {actionCount} {actionCount === 1 ? "action" : "actions"}
              </p>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Capabilities are not recorded on this session.
              </p>
            )}
            <Link
              href={consolePath("platform.profile")}
              className="mt-1 inline-block text-[13px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
              onClick={() => setOpen(false)}
            >
              View your access
            </Link>
          </div>

          <a
            href="/auth/logout"
            className="block px-2.5 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Sign out
          </a>
        </div>
      ) : null}
    </div>
  );
}
