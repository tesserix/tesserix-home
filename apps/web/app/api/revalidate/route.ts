import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";

// Collections the CMS publishes for this site, and the page each slug lives at.
// Same contract as yes-hospital/src/app/api/revalidate/route.ts.
const pages: Record<string, string | null> = {
  products: "/products/",
  "team-members": null,
  principles: null,
  beliefs: null,
  "open-source-projects": null,
};
const SLUG = /^[a-z0-9-]+$/;

// Hashing first makes the compare constant-time whatever the lengths.
const digest = (s: string) => createHash("sha256").update(s).digest();
const authorized = (given: string | null) => {
  const secret = process.env.CMS_WEBHOOK_SECRET;
  return Boolean(secret) && given !== null && timingSafeEqual(digest(given), digest(secret!));
};

/** The CMS's publish webhook: `{ collection, slug?, previousSlug? }` with `x-cms-secret`. */
export async function POST(req: Request) {
  if (!authorized(req.headers.get("x-cms-secret"))) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { collection?: unknown; slug?: unknown; previousSlug?: unknown } | null;
  const collection = body?.collection;
  const slugs = [body?.slug, body?.previousSlug].filter((s) => s !== undefined);
  if (typeof collection !== "string" || !Object.hasOwn(pages, collection) || !slugs.every((s) => typeof s === "string" && SLUG.test(s)))
    return Response.json({ error: "bad request" }, { status: 400 });

  // Also the umbrella tag: every page reads several collections. Expire now: the editor just
  // published. This only clears this pod's cache; other replicas catch up within the 60 s revalidate.
  const tags = [`cms:${collection}`, "cms"];
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  const prefix = pages[collection];
  if (prefix) for (const s of slugs) revalidatePath(`${prefix}${s}`);
  return Response.json({ revalidated: tags });
}
