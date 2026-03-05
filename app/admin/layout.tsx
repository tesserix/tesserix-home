"use client";

import { AuthProvider, useAuth } from "@/lib/auth/auth-context";
import { AdminSidebar } from "@/components/admin/sidebar";
import { ToastProvider, ToastViewport } from "@tesserix/web";
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

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <ToastProvider>
        <AuthGuard>
          <div className="min-h-screen bg-background">
            <AdminSidebar />
            <div className="lg:pl-72">
              {children}
            </div>
          </div>
        </AuthGuard>
        <ToastViewport position="bottom-right" />
      </ToastProvider>
    </AuthProvider>
  );
}
