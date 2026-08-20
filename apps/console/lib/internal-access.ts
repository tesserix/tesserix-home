import {
  CONSOLE_ENTRY_CAPABILITY,
  hasCapability,
  isPlatformOperator,
} from "@tesserix/platform-auth";

/**
 * Is this session an internal operator's?
 *
 * The console is for internal operators only, and today it cannot prove that.
 * It accepts any valid `.tesserix.app` session, which is safe purely because
 * `apps/web` admits nobody outside `ALLOWED_ADMIN_EMAILS`. The shared cookie
 * makes web's login policy the console's access policy by accident — and that
 * stops being safe the moment web admits a tenant, a customer, or anyone else.
 *
 * The gate is therefore role-based, with strictness tied to the auth provider
 * so the cutover is reversible and merging changes nothing:
 *
 * - `AUTH_PROVIDER` unset or `google` (today): sessions carry no roles at all.
 *   Requiring one would lock every operator out on deploy, so a role-less
 *   session is accepted exactly as it is now.
 * - `AUTH_PROVIDER=zitadel` (after cutover): every session carries roles from
 *   the TESSERIX org's Platform Console project, so a session lacking the entry
 *   capability is refused regardless of who minted it.
 *
 * The estate's own operators (`operators.ts`) are admitted on their email
 * alone. A missing role grant is an ordinary IdP mistake, and the console is
 * the wrong place to be locked out of when it happens.
 *
 * Note the asymmetry is deliberate and temporary. Once `ALLOWED_ADMIN_EMAILS`
 * retires, the `google` branch should go with it — leaving it behind would keep
 * a permanent bypass of the check this function exists to perform.
 */
export function requiresCapability(
  provider: string | undefined = process.env.AUTH_PROVIDER,
): boolean {
  return provider === "zitadel";
}

export function isInternal(
  roles: readonly string[] | undefined,
  provider: string | undefined = process.env.AUTH_PROVIDER,
  email?: string | null,
): boolean {
  if (!requiresCapability(provider)) return true;
  if (isPlatformOperator(email)) return true;
  return hasCapability(roles, CONSOLE_ENTRY_CAPABILITY);
}
