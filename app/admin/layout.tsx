"use client";

import { AuthProvider } from "@/lib/auth/auth-context";
import { AdminSidebar } from "@/components/admin/sidebar";
import { ToastProvider, ToastViewport } from "@tesserix/web";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <ToastProvider>
        <div className="min-h-screen bg-background">
          <AdminSidebar />
          <div className="lg:pl-72">
            {children}
          </div>
        </div>
        <ToastViewport position="bottom-right" />
      </ToastProvider>
    </AuthProvider>
  );
}
