// GET /api/waitlist/unsubscribe?token=… — one-click unsubscribe.
//
// Marketing mail must carry a working opt-out that needs no account and no
// login, so the token in the URL is the whole authorisation. Tokens are
// per-subscription random UUIDs, so one leaking reveals nothing and affects
// only that single list membership.
//
// Responds with a small HTML page rather than JSON: this URL is opened by a
// human clicking a link in an email client, not by a script.

import { type NextRequest } from "next/server";

import { unsubscribeByToken } from "@/lib/db/product-waitlist";
import { logger } from "@/lib/logger";
import { siteOrigin } from "@/lib/site-origin";

function page(title: string, message: string, status: number): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Tesserix</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #fff; color: #111;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 .5rem; }
  p { color: #555; margin: 0 0 1.5rem; }
  a { color: #111; text-underline-offset: 3px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0b0c; color: #f5f5f5; }
    p { color: #a1a1a1; }
    a { color: #f5f5f5; }
  }
</style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="${siteOrigin()}/">Back to Tesserix</a>
  </main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const token = request.nextUrl.searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return page(
      "Link incomplete",
      "That unsubscribe link is missing its token. Please use the link from the email exactly as it appears.",
      400,
    );
  }

  try {
    const ok = await unsubscribeByToken(token);
    if (!ok) {
      // Unknown token — most often an already-processed or hand-edited link.
      return page(
        "Nothing to unsubscribe",
        "This link is no longer valid. You may have already unsubscribed, in which case there is nothing more to do.",
        404,
      );
    }
    logger.info("[Waitlist] unsubscribed via token");
    return page(
      "You're unsubscribed",
      "We won't email you about this product again. You can rejoin from the product page any time.",
      200,
    );
  } catch (error) {
    logger.error("[Waitlist] unsubscribe failed", { error });
    return page(
      "Something went wrong",
      "We couldn't process that just now. Please try the link again shortly.",
      500,
    );
  }
}
