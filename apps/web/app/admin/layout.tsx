"use client";

import { AuthProvider, useAuth } from "@/lib/auth/auth-context";
import { AdminSidebar } from "@/components/admin/sidebar";
import { SupportQueueProvider } from "@/components/admin/support/SupportQueueNotifier";
import { CommandPaletteProvider } from "@/components/admin/command-palette";
import { ConfirmProvider } from "@/components/admin/confirm-dialog";
import { ToastProvider, ToastViewport, TooltipProvider } from "@tesserix/web";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, login } = useAuth();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      login({ returnTo: pathname });
    }
  }, [isLoading, isAuthenticated, login, pathname]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

// The admin console deliberately mounts NO support-chat widget.
//
// OttoSupportChat is a *storefront* surface: it posts to otto's
// /api/v1/storefront/otto/* endpoints as the "platform" tenant, and the
// /api/otto proxy forwards a signed-in admin as the CUSTOMER identity so they
// skip the OTP step. Rendering it here therefore let staff open new customer
// support conversations against their own platform inbox — the "What can we
// help with?" composer in the admin chrome. Admins consume queued customer
// conversations, they never originate them.
//
// Read-only support visibility lives in the console proper: /admin/analytics/
// support (cross-tenant otto rollup) and, for HomeChef, Support -> Tickets and
// Support -> Mediation. Anything added here in future must be a read/reply
// agent surface, not the storefront composer.

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <ToastProvider>
        <TooltipProvider delayDuration={200}>
          <AuthGuard>
            <CommandPaletteProvider>
              <ConfirmProvider>
                <SupportQueueProvider>
                  <div className="min-h-screen bg-background">
                    <AdminSidebar />
                    <div id="main-content" className="lg:pl-72">
                      {children}
                    </div>
                  </div>
                </SupportQueueProvider>
              </ConfirmProvider>
            </CommandPaletteProvider>
          </AuthGuard>
        </TooltipProvider>
        {/* Top-right so queue/status toasts land where the eye already goes
            (bell corner), pushed below the h-16 header so the bell itself is
            never covered.

            pointer-events-none is load-bearing, not cosmetic. The viewport is
            `fixed` and always mounted, and its p-4 gives it a 32px height even
            with zero toasts — a full-width invisible strip sitting at y=80,
            which is exactly the first entry of the product rail. That made
            "Overview" unclickable in every product (kora, mark8ly, homechef):
            the click landed on the empty toast container instead of the link.

            The child override is spelled `[&>*]:pointer-events-auto` rather
            than relying on the `pointer-events-auto` that @tesserix/web's Toast
            already carries, because this app's Tailwind content globs do not
            scan node_modules/@tesserix/web — that class name is emitted by the
            library but has no CSS rule here, so it would silently fail to
            re-enable clicks and leave every toast's close/action button dead.
            Written here, in app source, the rule is guaranteed to be generated. */}
        <ToastViewport
          position="top-right"
          className="top-20 pointer-events-none [&>*]:pointer-events-auto"
        />
      </ToastProvider>
    </AuthProvider>
  );
}
