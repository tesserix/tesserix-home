"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
} from "@tesserix/web";
export default function LoginPage() {
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/admin/dashboard";
  const error = searchParams.get("error");

  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  function handleGoogleLogin() {
    setIsGoogleLoading(true);
    const prompt = searchParams.get("prompt");
    const promptParam = prompt ? `&prompt=${encodeURIComponent(prompt)}` : "";
    const loginUrl = `/auth/login?returnTo=${encodeURIComponent(returnTo)}${promptParam}`;
    window.location.href = loginUrl;
  }

  const displayError = error === "session_expired"
    ? "Your session has expired. Please sign in again."
    : error === "auth_failed"
      ? "Authentication failed. Please try again."
      : error
        ? "An error occurred. Please try again."
        : null;

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      {/* Header */}
      <header className="p-6">
        <Link href="/" className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to home
        </Link>
      </header>

      {/* Main */}
      <main id="main-content" className="flex-1 flex items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="text-center">
            <Link href="/" className="inline-block mb-4">
              <Image src="/logo.png" alt="Tesserix" width={121} height={36} />
            </Link>
            <CardTitle className="text-2xl">Admin Portal Login</CardTitle>
            <CardDescription>
              Sign in to manage tenants, tickets, and platform settings.
              <span className="block mt-1 text-xs">
                For Tesserix staff and administrators only.
              </span>
            </CardDescription>
          </CardHeader>

          <CardContent>
            {displayError && (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive mb-4" role="alert">
                {displayError}
              </div>
            )}

            {/* Google Sign In — platform admins use Google OIDC only */}
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={handleGoogleLogin}
              disabled={isGoogleLoading}
              className="w-full gap-3"
            >
              {isGoogleLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <svg className="h-4 w-4" viewBox="0 0 24 24">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
              )}
              Continue with Google
            </Button>

            <div className="mt-6 text-center text-sm text-muted-foreground">
              <p>
                Need help?{" "}
                <Link href="/contact" className="text-foreground hover:underline">
                  Contact support
                </Link>
              </p>
            </div>

            {/* Home portal link */}
            <div className="mt-6 pt-6 border-t text-center">
              <p className="text-sm text-muted-foreground">
                <a
                  href="https://mark8ly.com"
                  className="text-foreground hover:underline"
                >
                  Go to home portal →
                </a>
              </p>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Footer */}
      <footer className="p-6 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} Tesserix. All rights reserved.</p>
      </footer>
    </div>
  );
}
