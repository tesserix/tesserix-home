"use client";

import { ConsoleCommandPalette } from "./command-palette";
import { HeaderTrail } from "./header-trail";
import { NotificationBell } from "./notification-bell";
import { OperatorMenu } from "./operator-menu";

const DEFAULT_TOOLS_BASE_DOMAIN = "tesserix.app";

export interface ConsoleHeaderProps {
  readonly name: string;
  readonly email: string;
  readonly capabilities: readonly string[];
  readonly showCapabilities: boolean;
  /**
   * Optional, defaulted, rather than required: existing render tests
   * construct `ConsoleHeader` without it, and the same fallback
   * `internal-tools.tsx` already uses is a perfectly good default.
   */
  readonly toolsBaseDomain?: string;
}

/**
 * The console's global bar: the ⌘K palette on the left, identity and the
 * bell grouped on the right.
 *
 * Deliberately carries no page title, and no leaf breadcrumb — every surface
 * renders its own ConsolePageHeader, and duplicating the title here would
 * give each page two. It does carry the ANCESTOR trail (`HeaderTrail`):
 * when a page's own breadcrumb scrolls out of view, this bar is the only
 * thing still on screen, so it is where the way back has to live.
 *
 * `capabilities`/`showCapabilities` already exist here for `OperatorMenu`;
 * the palette reuses them rather than taking a second, duplicate pair —
 * `showCapabilities` doubles as the palette's `enforceCapabilities`, since
 * both mean the same thing: this session's provider carries real capability
 * claims to filter by.
 */
export function ConsoleHeader({
  name,
  email,
  capabilities,
  showCapabilities,
  toolsBaseDomain = DEFAULT_TOOLS_BASE_DOMAIN,
}: ConsoleHeaderProps): React.JSX.Element {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-border bg-background/95 px-6 backdrop-blur sm:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <ConsoleCommandPalette
          capabilities={capabilities}
          enforceCapabilities={showCapabilities}
          toolsBaseDomain={toolsBaseDomain}
        />
        <HeaderTrail />
      </div>
      <div className="flex items-center gap-2">
        <NotificationBell />
        <OperatorMenu
          name={name}
          email={email}
          capabilities={capabilities}
          showCapabilities={showCapabilities}
        />
      </div>
    </header>
  );
}
