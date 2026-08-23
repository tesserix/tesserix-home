"use client";

import { ConsoleCommandPalette } from "./command-palette";
import { HeaderTrail } from "./header-trail";
import { HealthIndicator } from "./health-indicator";
import { NotificationBell } from "./notification-bell";
import { OperatorMenu } from "./operator-menu";
import type { DirectoryTool } from "@/lib/tools-directory";
import type { EstateHealth } from "@/lib/health";

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
  /**
   * Fetched server-side in app/(console)/layout.tsx and threaded straight
   * through to the palette. Deliberately no default: an empty-array default
   * would turn a plumbing mistake (forgetting to pass the directory) into a
   * silently empty palette instead of a type error.
   */
  readonly tools: readonly DirectoryTool[];
  /**
   * Fetched server-side in app/(console)/layout.tsx, like `tools`.
   * Deliberately no default: an "everything is fine" default would be the
   * exact lie the third state exists to prevent, introduced by a forgotten
   * prop rather than by a broken sensor.
   */
  readonly health: EstateHealth;
}

/**
 * The console's global bar: the breadcrumb trail on the left, the ⌘K
 * palette, bell, and identity grouped on the right.
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
  tools,
  health,
}: ConsoleHeaderProps): React.JSX.Element {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-border bg-background/95 px-6 backdrop-blur sm:px-8">
      <div className="flex min-w-0 items-center gap-3">
        <HeaderTrail />
      </div>
      <div className="flex items-center gap-2">
        <ConsoleCommandPalette
          capabilities={capabilities}
          enforceCapabilities={showCapabilities}
          toolsBaseDomain={toolsBaseDomain}
          tools={tools}
        />
        <HealthIndicator health={health} />
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
