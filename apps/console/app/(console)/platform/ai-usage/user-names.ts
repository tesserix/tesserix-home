import { fetchProductEntities } from "@/lib/platform-api";

export async function resolveUsageUserNames(
  product: string | undefined,
  userIds: readonly string[],
): Promise<Record<string, string>> {
  const pending = new Set(userIds.filter(Boolean));
  const names: Record<string, string> = {};
  if (product !== "kora" || pending.size === 0) return names;

  const signal = AbortSignal.timeout(5_000);

  // Bound optional enrichment; deleted accounts must not trigger an estate-wide scan.
  for (let page = 1, seen = 0; page <= 10 && pending.size > 0 && !signal.aborted; page++) {
    try {
      const result = await fetchProductEntities(product, "users", undefined, page, 100, signal);
      for (const user of result.data) {
        const prefix = `${product}:`;
        if (user.source !== product || user.type !== "users" || !user.id.startsWith(prefix)) continue;
        const userId = user.id.slice(prefix.length);
        if (pending.has(userId)) {
          if (user.label.trim() && user.label !== userId) names[userId] = user.label;
          pending.delete(userId);
        }
      }
      seen += result.data.length;
      if (result.data.length === 0 || seen >= result.pagination.total) break;
    } catch {
      break;
    }
  }
  return names;
}
