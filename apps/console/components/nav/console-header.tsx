"use client";

import { NotificationBell } from "./notification-bell";
import { OperatorMenu } from "./operator-menu";

export interface ConsoleHeaderProps {
  readonly name: string;
  readonly email: string;
  readonly capabilities: readonly string[];
  readonly showCapabilities: boolean;
}

/**
 * The console's global bar: identity and the bell, and later ⌘K.
 *
 * Deliberately carries no page title or breadcrumbs — every surface renders
 * its own ConsolePageHeader, and duplicating either here would give each page
 * two titles. The left side stays empty until ⌘K claims it (#135).
 */
export function ConsoleHeader({
  name,
  email,
  capabilities,
  showCapabilities,
}: ConsoleHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-end gap-2 border-b border-border bg-background/95 px-6 backdrop-blur sm:px-8">
      <NotificationBell />
      <OperatorMenu
        name={name}
        email={email}
        capabilities={capabilities}
        showCapabilities={showCapabilities}
      />
    </header>
  );
}
