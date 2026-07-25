"use client";

import { AuthProvider, useAuth } from "@/lib/auth/auth-context";
import { AdminSidebar } from "@/components/admin/sidebar";
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
                <div className="min-h-screen bg-background">
                  <AdminSidebar />
                  <div id="main-content" className="lg:pl-72">
                    {children}
                  </div>
                </div>
              </ConfirmProvider>
            </CommandPaletteProvider>
          </AuthGuard>
        </TooltipProvider>
        <ToastViewport position="bottom-right" />
      </ToastProvider>
    </AuthProvider>
  );
}
