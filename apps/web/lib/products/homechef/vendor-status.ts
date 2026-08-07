// Cashfree's Easy Split vendor verdict, said in words an operator can act on
// (Home-Chef-App #1122). Every one of these states is resolved by the chef in
// the vendor app — no bank detail is ever entered or shown in admin.

const LABELS: Record<string, string> = {
  ACTIVE: "Verified",
  IN_BANK_VALIDATION: "Bank details verifying",
  BANK_VALIDATION_FAILED: "Bank details rejected",
  BLOCKED: "Blocked by Cashfree",
};

const HINTS: Record<string, string> = {
  IN_BANK_VALIDATION: "Cashfree is still verifying — press Re-check to read the verdict.",
  BANK_VALIDATION_FAILED:
    "Cashfree rejected the account. The chef must re-enter their payout details in the vendor app; Re-check will not clear this on its own.",
  BLOCKED: "Cashfree has blocked this vendor — raise it with the account manager.",
};

const NOT_REGISTERED_HINT =
  "This kitchen has no payout details on file. The chef submits them in the vendor app, then Register sends them to Cashfree.";

function normalize(status?: string | null): string {
  return (status ?? "").trim().toUpperCase();
}

export function vendorStatusLabel(status?: string | null): string {
  const key = normalize(status);
  if (!key) return "Not registered";
  return LABELS[key] ?? status ?? key;
}

export function vendorStatusHint(status?: string | null): string | null {
  const key = normalize(status);
  if (!key) return NOT_REGISTERED_HINT;
  return HINTS[key] ?? null;
}
