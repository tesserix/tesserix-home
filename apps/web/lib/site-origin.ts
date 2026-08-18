/**
 * This site's own public origin — the single source of it in apps/web.
 *
 * It used to be `NEXT_PUBLIC_SITE_URL`, which next.config.ts inlined at build
 * time with a `http://localhost:3002` default. Nothing passed it as a Docker
 * build arg, so the inlined value could only ever be that loopback default —
 * while the company Deployment set `NEXT_PUBLIC_SITE_URL` at *runtime*, where a
 * `NEXT_PUBLIC_` variable does nothing for an already-inlined build. The
 * manifest looked configured and was not, and the OAuth callback carried a
 * special case to ignore the loopback it would otherwise have inherited.
 *
 * Every reader is server-side — the OAuth callback, the waitlist announcer, and
 * the SEO/metadata builders — so nothing needs inlining and `SITE_ORIGIN` is a
 * plain runtime variable. Keep it that way: this module has no client-side
 * story, and a client component importing it would quietly read `undefined` and
 * fall back to the default rather than fail.
 *
 * Runtime for the readers that matter, but not universally: robots.txt,
 * sitemap.xml and the root metadata are prerendered, so they capture whatever
 * `SITE_ORIGIN` was at build time. The login/redirect and email paths are
 * request-time and do read it live.
 *
 * The default is the live production host, so an unset variable is correct in
 * production; only staging/preview environments need to set anything.
 */
export const DEFAULT_SITE_ORIGIN = "https://tesserix.app";

/**
 * Returns the configured origin verbatim apart from trailing slashes, which are
 * stripped because callers append paths (`${siteOrigin()}/products/x`). A value
 * that is not a parseable absolute URL is treated as unconfigured rather than
 * thrown on: this is read on the login redirect path, where failing hard would
 * turn a config typo into a total outage.
 */
export function siteOrigin(): string {
  const configured = process.env.SITE_ORIGIN?.trim();
  if (!configured) return DEFAULT_SITE_ORIGIN;
  try {
    new URL(configured);
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
  return configured.replace(/\/+$/, "");
}
