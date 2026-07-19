"use client";

import { AuthProvider, useAuth } from "@/lib/auth/auth-context";
import { OttoSupportChat } from "@/components/OttoSupportChat";
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

// Admin-only support chat — public pages deliberately have no chat widget
// (visitors use /contact). Lives inside AuthGuard so it renders only for
// authenticated staff, with identity from the auth context so the widget
// skips the OTP step.
function AdminSupportChat() {
  const { user } = useAuth();
  return (
    <OttoSupportChat
      userEmail={user?.email ?? undefined}
      userName={user?.displayName ?? user?.name ?? undefined}
    />
  );
}

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
                  <AdminSupportChat />
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
