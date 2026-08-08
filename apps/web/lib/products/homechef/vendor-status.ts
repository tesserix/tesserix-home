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
  IN_BANK_VALIDATION:
    "Cashfree is still verifying — press Re-check to read the verdict.",
  BANK_VALIDATION_FAILED:
    "Cashfree rejected the account. The chef must re-enter their payout details in the vendor app, then Re-submit sends the corrected ones — re-submitting the same account fails again.",
  BLOCKED:
    "Cashfree has blocked this vendor — raise it with the account manager.",
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

export type VendorSyncAction = {
  endpoint: "register" | "refresh";
  label: string;
};

// Which sync a chef's vendor state calls for (#88). BANK_VALIDATION_FAILED is a
// refusal, not a stage — re-reading it returns the same verdict forever, and
// only a re-submission carries corrected details to Cashfree. A submission
// still in flight must not be re-sent on every click.
export function vendorSyncAction(
  status: string | null | undefined,
  vendorId: string | null | undefined,
): VendorSyncAction | null {
  const key = normalize(status);
  if (key === "ACTIVE") return null;
  if (!vendorId) return { endpoint: "register", label: "Register" };
  if (key === "BANK_VALIDATION_FAILED")
    return { endpoint: "register", label: "Re-submit" };
  return { endpoint: "refresh", label: "Re-check" };
}

// Whether to offer the sandbox bank seed, which puts Cashfree's documented test
// account on file so no operator types a real account number. Only a test-mode
// kitchen resolves to the sandbox payout rail, and the API refuses any other —
// an unknown mode reads as live, because that is the reading that cannot pay a
// stranger.
export function canSeedSandboxBank(mode?: string | null): boolean {
  return normalize(mode) === "TEST";
}
