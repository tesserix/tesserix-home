"use client";

import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { AlertTriangle, ArrowLeft, RefreshCw, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
  access_denied: {
    title: "Access Denied",
    description: "You do not have permission to access the admin portal. Contact your administrator if you believe this is an error.",
  },
  invalid_redirect: {
    title: "Configuration Error",
    description: "There was a problem with the login configuration. Please try again or contact support.",
  },
  session_expired: {
    title: "Session Expired",
    description: "Your session has expired. Please sign in again.",
  },
  callback_error: {
    title: "Login Failed",
    description: "Something went wrong during the login process. Please try again.",
  },
};

const DEFAULT_ERROR = {
  title: "Authentication Error",
  description: "An unexpected error occurred during authentication. Please try again.",
};

export default function AuthErrorPage() {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get("error") || "";
  const errorDescription = searchParams.get("error_description") || "";

  const errorInfo = ERROR_MESSAGES[errorCode] || DEFAULT_ERROR;
  const isAccessDenied = errorCode === "access_denied";

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      <header className="p-6">
        <Link href="/" className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to home
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="text-center">
            <Link href="/" className="inline-block mb-4">
              <Image src="/logo.png" alt="Tesserix" width={121} height={36} />
            </Link>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle className="text-xl">{errorInfo.title}</CardTitle>
          </CardHeader>

          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground text-center">
              {errorDescription || errorInfo.description}
            </p>

            <div className="flex flex-col gap-2">
              {isAccessDenied ? (
                <Button asChild className="w-full">
                  <Link href="/login?prompt=select_account">
                    <LogIn className="mr-2 h-4 w-4" />
                    Sign in with a different account
                  </Link>
                </Button>
              ) : (
                <Button asChild className="w-full">
                  <Link href="/login">
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Try Again
                  </Link>
                </Button>
              )}
              <Button variant="outline" asChild className="w-full">
                <Link href="/contact">Contact Support</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>

      <footer className="p-6 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} Tesserix. All rights reserved.</p>
      </footer>
    </div>
  );
}
