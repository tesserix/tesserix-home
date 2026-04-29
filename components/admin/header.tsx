"use client";

import type { LucideIcon } from "lucide-react";
import { Bell, Search } from "lucide-react";
import { Button, Input } from "@tesserix/web";

interface AdminHeaderProps {
  title: string;
  description?: string;
  icon?: React.ReactNode | LucideIcon;
}

export function AdminHeader({ title, description, icon: IconProp }: AdminHeaderProps) {
  // Lucide icons may be forwardRef objects (not plain functions) in React 19
  const isComponent =
    IconProp &&
    (typeof IconProp === "function" ||
      (typeof IconProp === "object" && "render" in IconProp));
  const iconElement = isComponent
    ? (() => { const IC = IconProp as LucideIcon; return <IC className="h-6 w-6 text-muted-foreground" />; })()
    : IconProp;

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center justify-between px-6">
        <div className="flex items-center gap-3">
          {iconElement}
          <div>
            <h1 className="text-xl font-semibold text-foreground">{title}</h1>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Search (desktop) */}
          <div className="relative hidden md:block">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              placeholder="Search..."
              className="w-64 pl-9"
              aria-label="Search"
            />
          </div>

          {/* Search (mobile) */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Search"
          >
            <Search className="h-5 w-5" aria-hidden="true" />
          </Button>

          {/* Notifications */}
          <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
            <Bell className="h-5 w-5" aria-hidden="true" />
            <span
              className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary"
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
    </header>
  );
}
