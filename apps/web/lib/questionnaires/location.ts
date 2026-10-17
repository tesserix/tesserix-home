import "server-only";
import { z } from "zod";
import { createHmac } from "node:crypto";
import { reserveQuestionnaireLookup } from "@tesserix/questionnaires/server";
import {
  countrySchema,
  addressSchema,
  lookupSchema,
  fallbackCountries,
} from "@tesserix/questionnaires/locations";

function serviceUrls() {
  const local =
    process.env.NODE_ENV === "development" &&
    process.env.QUESTIONNAIRES_LOCATION_LOCAL === "true";
  return {
    countries: local
      ? "http://127.0.0.1:18206"
      : "http://mark8ly-platform-api.mark8ly.svc.cluster.local:8086",
    addresses: local
      ? "http://127.0.0.1:18207"
      : "http://mark8ly-storefront.mark8ly.svc.cluster.local:4203",
  };
}
async function boundedJson(response: Response, max = 65536): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Location unavailable");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("Location response too large");
    }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function loadCountries() {
  try {
    const response = await fetch(
      `${serviceUrls().countries}/api/v1/locations/countries`,
      {
        next: { revalidate: 86400 },
        signal: AbortSignal.timeout(2500),
        redirect: "error",
      },
    );
    const payload = z
      .object({
        data: z
          .array(
            z.object({
              code: z.string(),
              name: z.string(),
              currency_code: z.string(),
            }),
          )
          .min(1)
          .max(300),
      })
      .parse(await boundedJson(response));
    return payload.data.map((c) =>
      countrySchema.parse({
        code: c.code,
        name: c.name,
        currency: c.currency_code,
      }),
    );
  } catch {
    return fallbackCountries;
  }
}
export async function fetchAddresses(
  q: string,
  country: string,
  signal: AbortSignal,
) {
  const url = new URL("/api/locations/autocomplete", serviceUrls().addresses);
  url.searchParams.set("q", q);
  url.searchParams.set("country", country);
  const response = await fetch(url, {
    headers: { Host: "mark8ly.com" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(4500)]),
  });
  const payload = z
    .object({ data: z.array(z.unknown()).max(30) })
    .parse(await boundedJson(response));
  return payload.data
    .flatMap((a) => {
      const parsed = addressSchema.safeParse(a);
      return parsed.success && parsed.data.country === country
        ? [parsed.data]
        : [];
    })
    .slice(0, 8);
}
const reply = (status: number, code: string, message: string) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
export async function lookupLocation(request: Request) {
  const allowed = new Set([
    "https://questionnaire.tesserix.app",
    "https://tesserix.app",
  ]);
  if (process.env.NODE_ENV === "development")
    allowed.add(new URL(request.url).origin);
  if (!allowed.has(request.headers.get("origin") ?? ""))
    return reply(403, "origin_denied", "Use the questionnaire page");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return reply(415, "content_type", "JSON is required");
  const client = request.headers.get("x-questionnaire-client") ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      client,
    )
  )
    return reply(400, "client_key", "Reload the questionnaire");
  let raw: unknown;
  try {
    raw = await boundedJson(new Response(request.body), 1024);
  } catch {
    return reply(400, "invalid_body", "Enter a short venue address");
  }
  const parsed = lookupSchema.safeParse(raw);
  if (!parsed.success)
    return reply(
      422,
      "invalid_lookup",
      "Choose a country and enter at least three characters",
    );
  try {
    const fingerprint = createHmac(
      "sha256",
      process.env.QUESTIONNAIRES_DB_PASSWORD ?? "unconfigured",
    )
      .update(
        new Date().toISOString().slice(0, 10) +
          (request.headers.get("cf-connecting-ip") ?? "unknown") +
          client,
      )
      .digest("hex");
    await reserveQuestionnaireLookup(fingerprint);
    const data = await fetchAddresses(
      parsed.data.q,
      parsed.data.country,
      request.signal,
    );
    return Response.json(
      { data },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const cause = e instanceof Error && "cause" in e ? e.cause : e;
    if ((cause as { code?: string })?.code === "P0003")
      return reply(
        429,
        "rate_limited",
        "Too many searches. Enter the address manually or try later.",
      );
    return reply(
      503,
      "lookup_unavailable",
      "Address search is unavailable. Please enter the address manually.",
    );
  }
}
