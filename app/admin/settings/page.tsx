"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Settings,
  User,
  Palette,
  Server,
  Shield,
  CreditCard,
  Sun,
  Moon,
  Monitor,
  LogOut,
  ExternalLink,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { useToast } from "@tesserix/web";
import { AdminHeader } from "@/components/admin/header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth/auth-context";

type Theme = "light" | "dark" | "system";

function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  return (localStorage.getItem("theme") as Theme) || "system";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches;
    root.classList.toggle("dark", prefersDark);
  } else {
    root.classList.toggle("dark", theme === "dark");
  }
  localStorage.setItem("theme", theme);
}

function ProfileTab() {
  const { user } = useAuth();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile Information</CardTitle>
        <CardDescription>Your account details</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {user ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted-foreground">User ID</p>
                <p className="font-mono text-sm">{user.id}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Email</p>
                <p className="text-sm font-medium">{user.email}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Display Name</p>
                <p className="text-sm font-medium">
                  {user.displayName || user.name || `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "Not set"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">First Name</p>
                <p className="text-sm font-medium">
                  {user.firstName || "Not set"}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Last Name</p>
                <p className="text-sm font-medium">
                  {user.lastName || "Not set"}
                </p>
              </div>
            </div>
            <div>
              <p className="text-sm text-muted-foreground mb-2">Roles</p>
              <div className="flex flex-wrap gap-2">
                {user.roles.map((role) => (
                  <Badge key={role} variant="secondary">
                    {role}
                  </Badge>
                ))}
                {user.roles.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No roles assigned
                  </p>
                )}
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Unable to load user information.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AppearanceTab() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    setTheme(getStoredTheme());
  }, []);

  function handleThemeChange(newTheme: Theme) {
    setTheme(newTheme);
    applyTheme(newTheme);
  }

  const themes: { value: Theme; label: string; icon: React.ElementType }[] = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Customize the look and feel</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium mb-3">Theme</p>
          <div className="grid grid-cols-3 gap-3">
            {themes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => handleThemeChange(value)}
                className={`flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors ${
                  theme === value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="text-sm font-medium">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PlatformTab() {
  const environment =
    process.env.NEXT_PUBLIC_ENVIRONMENT ||
    (typeof window !== "undefined" && window.location.hostname.includes("dev")
      ? "dev"
      : "production");

  const links = [
    {
      label: "Manage Billing",
      href: "/admin/apps/mark8ly/billing",
      description: "Subscription plans and invoices",
    },
    {
      label: "Feature Flags",
      href: "/admin/feature-flags",
      description: "Toggle features for tenants",
    },
    {
      label: "Email Templates",
      href: "/admin/email-templates",
      description: "Customize notification emails",
    },
    {
      label: "System Health",
      href: "/admin/system-health",
      description: "Service status and uptime",
    },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Platform Information</CardTitle>
          <CardDescription>Environment and configuration</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">Environment</p>
              <Badge
                variant={
                  environment === "production" ? "destructive" : "secondary"
                }
                className="mt-1"
              >
                {environment}
              </Badge>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Platform</p>
              <p className="text-sm font-medium">Tesserix Home</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Management</CardTitle>
          <CardDescription>Quick links to platform settings</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-muted/50"
              >
                <div>
                  <p className="text-sm font-medium">{link.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {link.description}
                  </p>
                </div>
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
              </a>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SecurityTab() {
  const { user, isAuthenticated, logout } = useAuth();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Your current session information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">Status</p>
              <Badge variant={isAuthenticated ? "success" : "destructive"}>
                {isAuthenticated ? "Authenticated" : "Not authenticated"}
              </Badge>
            </div>
            {user && (
              <div>
                <p className="text-sm text-muted-foreground">Logged in as</p>
                <p className="text-sm font-medium">{user.email}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
          <CardDescription>Session management</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => logout()}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Sign Out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

interface StripeSettings {
  secretKeyConfigured: boolean;
  secretKeyHint: string;
  webhookSecretConfigured: boolean;
  webhookSecretHint: string;
  keySource: string;
}

interface VerifyResult {
  valid: boolean;
  accountId?: string;
  accountName?: string;
  livemode: boolean;
  error?: string;
}

function PaymentTab() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<StripeSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [showUpdateForm, setShowUpdateForm] = useState(false);

  // Update form state
  const [secretKey, setSecretKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);

  // Action states
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/subscriptions/admin/settings/stripe");
      if (res.ok) {
        setSettings(await res.json());
      }
    } catch {
      console.error("Failed to fetch Stripe settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function handleVerify() {
    if (!secretKey.trim()) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/subscriptions/admin/settings/stripe/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secretKey }),
      });
      const data = await res.json();
      setVerifyResult(data);
    } catch {
      setVerifyResult({ valid: false, livemode: false, error: "Request failed" });
    } finally {
      setVerifying(false);
    }
  }

  async function handleSave() {
    const body: Record<string, string> = {};
    if (secretKey.trim()) body.secretKey = secretKey;
    if (webhookSecret.trim()) body.webhookSecret = webhookSecret;

    if (Object.keys(body).length === 0) {
      toast({ title: "Enter at least one key to update", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/subscriptions/admin/settings/stripe", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        toast({ title: "Stripe keys updated successfully", variant: "success" });
        setSecretKey("");
        setWebhookSecret("");
        setVerifyResult(null);
        setShowUpdateForm(false);
        fetchSettings();
      } else {
        const data = await res.json();
        toast({ title: data.error || "Failed to update keys", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to update Stripe keys", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleReload() {
    setReloading(true);
    try {
      const res = await fetch("/api/subscriptions/admin/settings/stripe/reload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        toast({ title: "Stripe keys reloaded from source", variant: "success" });
      } else {
        toast({ title: "Failed to reload keys", variant: "destructive" });
      }
    } catch {
      toast({ title: "Failed to reload Stripe keys", variant: "destructive" });
    } finally {
      setReloading(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Stripe Configuration</CardTitle>
          <CardDescription>Manage your Stripe API keys for billing</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {settings ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Secret Key</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant={settings.secretKeyConfigured ? "success" : "destructive"}>
                      {settings.secretKeyConfigured ? "Configured" : "Not set"}
                    </Badge>
                    {settings.secretKeyHint && (
                      <code className="text-xs text-muted-foreground">{settings.secretKeyHint}</code>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Webhook Secret</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant={settings.webhookSecretConfigured ? "success" : "destructive"}>
                      {settings.webhookSecretConfigured ? "Configured" : "Not set"}
                    </Badge>
                    {settings.webhookSecretHint && (
                      <code className="text-xs text-muted-foreground">{settings.webhookSecretHint}</code>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Source</p>
                  <Badge variant="secondary" className="mt-1">
                    {settings.keySource === "gcp" ? "GCP Secret Manager" : "Environment Variable"}
                  </Badge>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowUpdateForm(!showUpdateForm);
                    setVerifyResult(null);
                  }}
                >
                  {showUpdateForm ? "Cancel" : "Update Keys"}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleReload}
                  disabled={reloading}
                >
                  {reloading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Reload from Source
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Unable to load Stripe settings. The subscription service may be unavailable.
            </p>
          )}
        </CardContent>
      </Card>

      {showUpdateForm && (
        <Card>
          <CardHeader>
            <CardTitle>Update Stripe Keys</CardTitle>
            <CardDescription>
              Enter new keys to save to {settings?.keySource === "gcp" ? "GCP Secret Manager" : "the server"}.
              Leave a field empty to keep the current value.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="secretKey">Stripe Secret Key</Label>
              <div className="relative">
                <Input
                  id="secretKey"
                  type={showSecretKey ? "text" : "password"}
                  placeholder="sk_live_..."
                  value={secretKey}
                  onChange={(e) => {
                    setSecretKey(e.target.value);
                    setVerifyResult(null);
                  }}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowSecretKey(!showSecretKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showSecretKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>

              {secretKey.trim() && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleVerify}
                    disabled={verifying}
                  >
                    {verifying ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-2 h-3 w-3" />
                    )}
                    Verify Key
                  </Button>
                  {verifyResult && (
                    <div className="flex items-center gap-1 text-sm">
                      {verifyResult.valid ? (
                        <>
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                          <span className="text-green-600">
                            Valid ({verifyResult.accountId}
                            {verifyResult.accountName ? `, ${verifyResult.accountName}` : ""}
                            {verifyResult.livemode ? ", Live" : ", Test"})
                          </span>
                        </>
                      ) : (
                        <>
                          <XCircle className="h-4 w-4 text-destructive" />
                          <span className="text-destructive">
                            Invalid: {verifyResult.error}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="webhookSecret">Webhook Secret</Label>
              <div className="relative">
                <Input
                  id="webhookSecret"
                  type={showWebhookSecret ? "text" : "password"}
                  placeholder="whsec_..."
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save to {settings?.keySource === "gcp" ? "GCP" : "Server"}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowUpdateForm(false);
                  setSecretKey("");
                  setWebhookSecret("");
                  setVerifyResult(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <>
      <AdminHeader
        title="Settings"
        description="Manage your account and platform settings"
        icon={<Settings className="h-6 w-6 text-muted-foreground" />}
      />

      <main className="p-6">
        <Tabs defaultValue="profile" className="space-y-6">
          <TabsList>
            <TabsTrigger value="profile" className="gap-2">
              <User className="h-4 w-4" />
              Profile
            </TabsTrigger>
            <TabsTrigger value="appearance" className="gap-2">
              <Palette className="h-4 w-4" />
              Appearance
            </TabsTrigger>
            <TabsTrigger value="platform" className="gap-2">
              <Server className="h-4 w-4" />
              Platform
            </TabsTrigger>
            <TabsTrigger value="security" className="gap-2">
              <Shield className="h-4 w-4" />
              Security
            </TabsTrigger>
            <TabsTrigger value="payment" className="gap-2">
              <CreditCard className="h-4 w-4" />
              Payment
            </TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <ProfileTab />
          </TabsContent>

          <TabsContent value="appearance">
            <AppearanceTab />
          </TabsContent>

          <TabsContent value="platform">
            <PlatformTab />
          </TabsContent>

          <TabsContent value="security">
            <SecurityTab />
          </TabsContent>

          <TabsContent value="payment">
            <PaymentTab />
          </TabsContent>
        </Tabs>
      </main>
    </>
  );
}
