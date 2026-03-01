"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Ticket,
  CreditCard,
  ScrollText,
  Activity,
  ToggleLeft,
  Mail,
  Settings,
  LogOut,
  Menu,
  X,
  Users,
  Rocket,
  ClipboardList,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/lib/auth/auth-context";

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

const platformNav: NavItem[] = [
  { name: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { name: "System Health", href: "/admin/system-health", icon: Activity },
  { name: "Releases", href: "/admin/releases", icon: Rocket },
  { name: "Email Templates", href: "/admin/email-templates", icon: Mail },
  { name: "Audit Logs", href: "/admin/audit-logs", icon: ScrollText },
  { name: "Settings", href: "/admin/settings", icon: Settings },
];

const mark8lyNav: NavItem[] = [
  { name: "Overview", href: "/admin/apps/mark8ly", icon: LayoutDashboard },
  { name: "Tenants", href: "/admin/apps/mark8ly/tenants", icon: Users },
  { name: "Tickets", href: "/admin/apps/mark8ly/tickets", icon: Ticket },
  { name: "Onboarding", href: "/admin/apps/mark8ly/onboarding", icon: ClipboardList },
  { name: "Billing", href: "/admin/apps/mark8ly/billing", icon: CreditCard },
  { name: "Feature Flags", href: "/admin/apps/mark8ly/feature-flags", icon: ToggleLeft },
  { name: "Email Templates", href: "/admin/apps/mark8ly/email-templates", icon: Mail },
];

type RailContext = "platform" | "mark8ly";

function getActiveContext(pathname: string): RailContext {
  if (pathname.startsWith("/admin/apps/mark8ly")) return "mark8ly";
  if (pathname.startsWith("/admin/apps")) return "platform";
  return "platform";
}

function getSecondaryNav(context: RailContext): { label: string; items: NavItem[] } {
  switch (context) {
    case "mark8ly":
      return { label: "Mark8ly", items: mark8lyNav };
    case "platform":
    default:
      return { label: "Platform", items: platformNav };
  }
}

function isNavItemActive(pathname: string, href: string): boolean {
  // Exact match for overview pages to avoid "/admin/apps/mark8ly" matching "/admin/apps/mark8ly/tenants"
  if (href === "/admin/apps/mark8ly") {
    return pathname === "/admin/apps/mark8ly" || pathname === "/admin/apps/mark8ly/";
  }
  return pathname.startsWith(href);
}

function RailIcon({
  icon: Icon,
  label,
  isActive,
  onClick,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  isActive: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const content = (
    <div
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-lg transition-colors cursor-pointer",
        isActive
          ? "bg-sidebar-accent text-sidebar-foreground"
          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      )}
    >
      <Icon className="h-5 w-5" />
    </div>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Link href={href} onClick={onClick}>
            {content}
          </Link>
        ) : (
          <button onClick={onClick}>{content}</button>
        )}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function LeftRail({
  activeContext,
  onContextChange,
  user,
  onLogout,
}: {
  activeContext: RailContext;
  onContextChange: (ctx: RailContext) => void;
  user: { firstName?: string; email?: string; displayName?: string } | null;
  onLogout: () => void;
}) {
  return (
    <div className="flex h-full w-16 flex-col items-center bg-sidebar border-r border-sidebar-border">
      {/* Logo */}
      <div className="flex h-16 items-center justify-center">
        <Link
          href="/admin/dashboard"
          className="flex h-9 w-9 items-center justify-center rounded-lg"
        >
          <Image
            src="/icon.png"
            alt="Tesserix"
            width={28}
            height={28}
            className="brightness-0 invert"
          />
        </Link>
      </div>

      <Separator className="mx-2 bg-sidebar-border" />

      {/* Context icons */}
      <div className="flex flex-1 flex-col items-center gap-2 py-4">
        <RailIcon
          icon={LayoutDashboard}
          label="Platform"
          isActive={activeContext === "platform"}
          onClick={() => onContextChange("platform")}
          href="/admin/dashboard"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/admin/apps/mark8ly"
              onClick={() => onContextChange("mark8ly")}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-lg transition-colors",
                activeContext === "mark8ly"
                  ? "bg-sidebar-accent"
                  : "hover:bg-sidebar-accent/50"
              )}
            >
              <Image
                src="/mark8ly-icon.png"
                alt="Mark8ly"
                width={24}
                height={24}
                className="rounded-sm brightness-0 invert"
              />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Mark8ly
          </TooltipContent>
        </Tooltip>
      </div>

      {/* User avatar + Logout at bottom */}
      <div className="flex flex-col items-center gap-2 pb-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-accent-foreground text-sm font-medium">
              {user?.firstName?.[0] || user?.email?.[0] || "A"}
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {user?.displayName || user?.email || "Admin"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onLogout}
              className="flex h-10 w-10 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Logout
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function SecondarySidebar({
  label,
  items,
  pathname,
  onItemClick,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  onItemClick?: () => void;
}) {
  return (
    <div className="flex h-full w-56 flex-col bg-sidebar">
      {/* Section header */}
      <div className="flex h-16 items-center px-5">
        <h2 className="text-sm font-semibold text-sidebar-foreground">{label}</h2>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* Navigation items */}
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-1">
          {items.map((item) => {
            const isActive = isNavItemActive(pathname, item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
                onClick={onItemClick}
              >
                <item.icon className="h-4 w-4" />
                {item.name}
              </Link>
            );
          })}
        </nav>
      </ScrollArea>
    </div>
  );
}

export function AdminSidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const activeContext = getActiveContext(pathname);
  const { label, items } = getSecondaryNav(activeContext);

  return (
    <TooltipProvider delayDuration={0}>
      {/* Mobile menu button */}
      <div className="fixed left-4 top-4 z-50 lg:hidden">
        <Button
          variant="outline"
          size="icon"
          className="bg-background"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          {mobileMenuOpen ? (
            <X className="h-5 w-5" />
          ) : (
            <Menu className="h-5 w-5" />
          )}
          <span className="sr-only">Toggle menu</span>
        </Button>
      </div>

      {/* Mobile sidebar — combined single panel */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 flex w-72 flex-col bg-sidebar">
            {/* Mobile header */}
            <div className="flex h-16 items-center px-5">
              <Link href="/admin/dashboard" className="flex items-center" onClick={() => setMobileMenuOpen(false)}>
                <Image src="/logo.png" alt="Tesserix" width={94} height={28} className="brightness-0 invert" />
              </Link>
            </div>

            <Separator className="bg-sidebar-border" />

            {/* Context switcher */}
            <div className="flex gap-1 px-3 py-3">
              <button
                onClick={() => {}}
                className={cn(
                  "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  activeContext === "platform"
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50"
                )}
              >
                <Link href="/admin/dashboard" onClick={() => setMobileMenuOpen(false)}>
                  Platform
                </Link>
              </button>
              <button
                onClick={() => {}}
                className={cn(
                  "flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  activeContext === "mark8ly"
                    ? "bg-sidebar-accent text-sidebar-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50"
                )}
              >
                <Link href="/admin/apps/mark8ly" onClick={() => setMobileMenuOpen(false)}>
                  Mark8ly
                </Link>
              </button>
            </div>

            <Separator className="bg-sidebar-border" />

            {/* Nav items */}
            <ScrollArea className="flex-1 px-3 py-4">
              <nav className="space-y-1">
                {items.map((item) => {
                  const isActive = isNavItemActive(pathname, item.href);
                  return (
                    <Link
                      key={item.name}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-foreground"
                          : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                      )}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      <item.icon className="h-5 w-5" />
                      {item.name}
                    </Link>
                  );
                })}
              </nav>
            </ScrollArea>

            {/* User */}
            <div className="border-t border-sidebar-border p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-accent-foreground">
                  {user?.firstName?.[0] || user?.email?.[0] || "A"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-medium text-sidebar-foreground">
                    {user?.displayName || user?.email || "Admin"}
                  </p>
                  <p className="truncate text-xs text-sidebar-foreground/50">
                    {user?.email}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  onClick={() => logout()}
                >
                  <LogOut className="h-4 w-4" />
                  <span className="sr-only">Logout</span>
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop sidebar — two panels */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex">
        <LeftRail
          activeContext={activeContext}
          onContextChange={() => {}}
          user={user}
          onLogout={logout}
        />
        <SecondarySidebar
          label={label}
          items={items}
          pathname={pathname}
        />
      </div>
    </TooltipProvider>
  );
}
