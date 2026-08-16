"use client";

import { ConsoleCommandPalette } from "./command-palette";
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
 * Deliberately carries no page title or breadcrumbs — every surface renders
 * its own ConsolePageHeader, and duplicating either here would give each page
 * two titles.
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
      <ConsoleCommandPalette
        capabilities={capabilities}
        enforceCapabilities={showCapabilities}
        toolsBaseDomain={toolsBaseDomain}
      />
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
