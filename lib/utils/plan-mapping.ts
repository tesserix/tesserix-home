import type { SubscriptionPlan } from "@/lib/api/subscriptions";
import type { PaymentPlan } from "@/lib/api/onboarding-content";

// ─── Feature label mapping ──────────────────────────────────────────────────

export const FEATURE_LABELS: Record<string, string> = {
  basic_analytics: "Basic Analytics",
  advanced_analytics: "Advanced Analytics",
  email_support: "Email Support",
  priority_support: "Priority Support",
  api_access: "API Access",
  custom_domain: "Custom Domain",
  dedicated_support: "Dedicated Support",
  sla: "Service Level Agreement",
};

// ─── Exchange rates & supported countries ───────────────────────────────────

export const EXCHANGE_RATES: Record<string, { rate: number; symbol: string }> = {
  AUD: { rate: 1, symbol: "A$" },
  INR: { rate: 55.0, symbol: "₹" },
  USD: { rate: 0.65, symbol: "$" },
  GBP: { rate: 0.52, symbol: "£" },
  EUR: { rate: 0.60, symbol: "€" },
  SGD: { rate: 0.88, symbol: "S$" },
  NZD: { rate: 1.08, symbol: "NZ$" },
};

export const SUPPORTED_COUNTRIES: { code: string; currency: string; name: string }[] = [
  { code: "AU", currency: "AUD", name: "Australia" },
  { code: "IN", currency: "INR", name: "India" },
  { code: "US", currency: "USD", name: "United States" },
  { code: "GB", currency: "GBP", name: "United Kingdom" },
  { code: "SG", currency: "SGD", name: "Singapore" },
  { code: "NZ", currency: "NZD", name: "New Zealand" },
];

// ─── Charm pricing ──────────────────────────────────────────────────────────

/**
 * Apply charm pricing to make prices psychologically appealing.
 * - INR: round to nearest ending in 9 (e.g. 1599, 4349)
 * - Other currencies: round to nearest .49 or .99
 */
export function charmPrice(amount: number, currency: string): number {
  if (amount <= 0) return 0;

  if (currency === "INR") {
    // For INR: pick nearest value ending in 9
    // e.g. 1595 → 1599, 4345 → 4349
    const floored = Math.floor(amount);
    const lastTwo = floored % 100;

    if (lastTwo <= 49) {
      // Pick x49
      return floored - lastTwo + 49;
    } else {
      // Pick x99
      return floored - lastTwo + 99;
    }
  }

  // For AUD/USD/GBP/EUR/SGD/NZD: round to .49 or .99
  const whole = Math.floor(amount);
  const frac = amount - whole;

  if (frac <= 0.24) {
    // Go down to previous .99 if it makes sense, otherwise .49
    return whole > 0 ? whole - 1 + 0.99 : 0.99;
  } else if (frac <= 0.74) {
    return whole + 0.49;
  } else {
    return whole + 0.99;
  }
}

/**
 * Convert a base AUD price to a target currency with charm pricing.
 */
export function calculateRegionalPrice(baseAud: number, targetCurrency: string): number {
  const target = EXCHANGE_RATES[targetCurrency];
  if (!target) return baseAud;

  const converted = baseAud * target.rate;
  return charmPrice(converted, targetCurrency);
}

// ─── Subscription → PaymentPlan mapper ──────────────────────────────────────

/**
 * Map a subscription plan (billing) to a payment plan (onboarding content).
 */
export function subscriptionToPaymentPlan(sub: SubscriptionPlan): Partial<PaymentPlan> {
  return {
    name: sub.displayName,
    slug: sub.name,
    price: (sub.monthlyPriceCents / 100).toFixed(2),
    currency: "AUD",
    billingCycle: "monthly",
    trialDays: sub.trialDays,
    tagline: sub.description || null,
    active: sub.isActive,
    sortOrder: sub.sortOrder,
  };
}

// ─── Feature text generator ─────────────────────────────────────────────────

/**
 * Generate human-readable feature strings from a subscription plan's
 * limits and boolean features.
 */
export function subscriptionFeatureTexts(sub: SubscriptionPlan): string[] {
  const texts: string[] = [];

  // Limits
  if (sub.maxProducts === -1) {
    texts.push("Unlimited Products");
  } else if (sub.maxProducts > 0) {
    texts.push(`Up to ${sub.maxProducts.toLocaleString()} Products`);
  }

  if (sub.maxUsers === -1) {
    texts.push("Unlimited Users");
  } else if (sub.maxUsers > 0) {
    texts.push(`Up to ${sub.maxUsers.toLocaleString()} Users`);
  }

  if (sub.maxStorageMb === -1) {
    texts.push("Unlimited Storage");
  } else if (sub.maxStorageMb > 0) {
    if (sub.maxStorageMb >= 1024) {
      texts.push(`${Math.floor(sub.maxStorageMb / 1024)} GB Storage`);
    } else {
      texts.push(`${sub.maxStorageMb} MB Storage`);
    }
  }

  if (sub.trialDays > 0) {
    texts.push(`${sub.trialDays}-day Free Trial`);
  }

  // Boolean features
  const features = sub.features || {};
  for (const [key, enabled] of Object.entries(features)) {
    if (enabled) {
      texts.push(FEATURE_LABELS[key] || key.replace(/_/g, " "));
    }
  }

  return texts;
}
