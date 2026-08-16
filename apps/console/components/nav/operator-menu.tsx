"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";

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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/60 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="truncate text-[13px] font-medium text-sidebar-foreground">
          {displayName}
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="ml-auto h-3.5 w-3.5 shrink-0 text-sidebar-foreground/40"
        />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Operator menu"
          className="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-md border border-sidebar-border bg-sidebar shadow-lg"
        >
          <div className="border-b border-sidebar-border px-2.5 py-2">
            <p className="truncate text-[13px] text-sidebar-foreground/75">{email}</p>
          </div>

          <div className="border-b border-sidebar-border px-2.5 py-2">
            {showCapabilities ? (
              <ul className="space-y-0.5">
                {capabilities.map((capability) => (
                  <li
                    key={capability}
                    className="text-[13px] text-sidebar-foreground/75"
                  >
                    {capability}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-sidebar-foreground/75">
                Capabilities are not recorded on this session.
              </p>
            )}
            <p className="mt-1 text-[11px] text-sidebar-foreground/50">
              Reflects the session, which can lag Zitadel until the next
              sign-in.
            </p>
          </div>

          <a
            href="/auth/logout"
            className="block px-2.5 py-2 text-[13px] text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
          >
            Sign out
          </a>
        </div>
      ) : null}
    </div>
  );
}
