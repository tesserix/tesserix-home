// Edge-safe extraction of an `Authorization: Bearer <token>` value.
// Kept free of Node-only imports so apps/web/middleware.ts can use it.
export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (!/^bearer\s+/i.test(trimmed)) return null;
  const token = trimmed.replace(/^bearer\s+/i, "").trim();
  return token.length > 0 ? token : null;
}
