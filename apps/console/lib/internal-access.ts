import { isPlatformOperator } from "@tesserix/platform-auth";

/**
 * Is this session an internal operator's?
 *
 * Under `zitadel` the allowlist in `operators.ts` is the whole gate: it admits
 * on email alone, and a role grant is neither necessary nor sufficient. Before
 * cutover sessions carry no roles at all, so `google` accepts them unchanged
 * rather than locking every operator out on deploy.
 */
export function requiresCapability(
  provider: string | undefined = process.env.AUTH_PROVIDER,
): boolean {
  return provider === "zitadel";
}

/** `roles` is accepted and ignored — the allowlist decides, grants do not. */
export function isInternal(
  roles: readonly string[] | undefined,
  provider: string | undefined = process.env.AUTH_PROVIDER,
  email?: string | null,
): boolean {
  if (!requiresCapability(provider)) return true;
  return isPlatformOperator(email);
}
