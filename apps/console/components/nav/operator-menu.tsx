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
        className="flex items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="truncate text-[13px] font-medium text-foreground">
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
            {showCapabilities ? (
              <ul className="space-y-0.5">
                {capabilities.map((capability) => (
                  <li
                    key={capability}
                    className="text-[13px] text-muted-foreground"
                  >
                    {capability}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Capabilities are not recorded on this session.
              </p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Reflects the session, which can lag Zitadel until the next
              sign-in.
            </p>
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
