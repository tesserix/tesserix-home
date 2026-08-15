import { NextResponse } from "next/server";

// The marketing pages are statically prerendered, so the OpenPanel client id
// supplied by the Helm chart at runtime can never be baked into their HTML.
// The browser reads it from here instead.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      clientId: process.env.OPENPANEL_CLIENT_ID ?? null,
      apiUrl: process.env.OPENPANEL_API_URL ?? null,
      scriptUrl: process.env.OPENPANEL_SCRIPT_URL ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
