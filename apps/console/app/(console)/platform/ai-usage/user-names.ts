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
        if (user.source === product && user.type === "users" && pending.has(user.id)) {
          if (user.label.trim() && user.label !== user.id) names[user.id] = user.label;
          pending.delete(user.id);
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
