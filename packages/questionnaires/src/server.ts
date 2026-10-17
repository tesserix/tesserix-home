import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { isFormId, minorUnits, validateSubmission, type FormId } from "./index";

let database: ReturnType<typeof drizzle> | undefined;
export function questionnaireDb() {
  if (database) return database;
  if (!process.env.QUESTIONNAIRES_DB_PASSWORD)
    throw new Error("Questionnaires unavailable");
  const pool = new Pool({
    host:
      process.env.QUESTIONNAIRES_DB_HOST ??
      "tesserix-postgres-rw.tesserix.svc.cluster.local",
    port: Number(process.env.QUESTIONNAIRES_DB_PORT ?? 5432),
    database: "questionnaires",
    user: process.env.QUESTIONNAIRES_DB_USER,
    password: process.env.QUESTIONNAIRES_DB_PASSWORD,
    max: 2,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    maxLifetimeSeconds: 300,
    statement_timeout: 5000,
    ssl:
      process.env.QUESTIONNAIRES_DB_LOCAL === "true"
        ? false
        : { rejectUnauthorized: true, ca: process.env.QUESTIONNAIRES_DB_CA },
  });
  database = drizzle(pool);
  return database;
}
const reply = (status: number, code: string, message: string) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
export async function submitQuestionnaire(
  request: Request,
  formValue: string,
): Promise<Response> {
  if (!isFormId(formValue))
    return reply(404, "not_found", "Questionnaire not found");
  const allowed = new Set([
    "https://questionnaire.tesserix.app",
    "https://tesserix.app",
  ]);
  if (process.env.NODE_ENV === "development")
    allowed.add(new URL(request.url).origin);
  if (!allowed.has(request.headers.get("origin") ?? ""))
    return reply(403, "origin_denied", "Submit from the questionnaire page");
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return reply(415, "content_type", "A JSON submission is required");
  const client = request.headers.get("x-questionnaire-client");
  if (
    !client ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      client,
    )
  )
    return reply(400, "client_key", "Reload the questionnaire and try again");
  const key = request.headers.get("idempotency-key");
  if (
    !key ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      key,
    )
  )
    return reply(400, "request_key", "A valid submission key is required");
  let raw = "";
  const reader = request.body?.getReader();
  if (reader) {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        return reply(413, "too_large", "Please shorten your answers");
      }
      chunks.push(part.value);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return reply(400, "invalid_json", "Please check your answers");
  }
  const parsed = validateSubmission(formValue, payload);
  if (!parsed.success)
    return Response.json(
      {
        error: {
          code: "invalid_answers",
          message: "Please check the highlighted answers",
        },
        fields: parsed.error.flatten().fieldErrors,
      },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  try {
    // The global bucket stays effective even if a client spoofs address headers.
    const address = request.headers.get("cf-connecting-ip") ?? "unknown";
    const fingerprint = createHmac(
      "sha256",
      process.env.QUESTIONNAIRES_DB_PASSWORD ?? "unconfigured",
    )
      .update(new Date().toISOString().slice(0, 10) + address + client)
      .digest("hex");
    const p = parsed.data;
    const result = await questionnaireDb().execute(
      sql`select questionnaires_api.submit(${formValue},${key}::uuid,${JSON.stringify(p)}::jsonb,${fingerprint},${minorUnits(p.maxSnackPrice, String(p.currency))},${minorUnits(p.maxDrinkPrice, String(p.currency))}) as receipt`,
    );
    return Response.json(
      { receipt: result.rows[0].receipt },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const cause = e instanceof Error && "cause" in e ? e.cause : e;
    const code = (cause as { code?: string })?.code;
    if (code === "P0002")
      return reply(
        409,
        "intent_conflict",
        "This submission key was used for different answers. Reload to start a new response.",
      );
    if (code === "P0003")
      return reply(
        429,
        "rate_limited",
        "Too many responses. Please try again later.",
      );
    console.error("questionnaire_submission_unavailable", { form: formValue });
    return reply(
      503,
      "unavailable",
      "We could not confirm your response. Please retry without changing your answers.",
    );
  }
}
export type SurveyFilter = {
  venue: string;
  country: string;
  campaign: string;
  region?: string;
};
export async function readQuestionnaireReport(
  form: FormId,
  filter: SurveyFilter,
  after = "0",
) {
  const db = questionnaireDb();
  const table =
    form === "vending-customers"
      ? sql`vending_customers.responses`
      : sql`vending_business.responses`;
  const region = filter.region?.trim() ?? "";
  const where = sql`(${filter.venue}='' or r.venue_type=${filter.venue}) and (${filter.country}='' or r.country=${filter.country}) and (${filter.campaign}='' or r.campaign=${filter.campaign}) and (${region}='' or lower(btrim(r.answers->>'region'))=lower(${region}))`;
  const [counts, latest, products, prices, variants] = await Promise.all([
    db.execute(
      sql`select count(*)::int as total, count(*) filter(where jsonb_typeof(r.answers->'productVariants')='array' and r.answers->'productVariants'<>'[]'::jsonb)::int as variant_responses from ${table} r where ${where}`,
    ),
    db.execute(
      sql`select r.id::text,r.created_at,r.answers from ${table} r where ${where} and (${after}::bigint=0 or r.id<${after}::bigint) order by r.id desc limit 31`,
    ),
    form === "vending-customers"
      ? db.execute(
          sql`select p.product,count(*)::int as votes,count(*) filter(where r.answers->>'topProduct'=p.product)::int as first_choices from vending_customers.product_preferences p join vending_customers.responses r on r.id=p.response_id where ${where} group by p.product order by votes desc,p.product`,
        )
      : Promise.resolve({ rows: [] }),
    form === "vending-customers"
      ? db.execute(
          sql`select r.currency,count(r.snack_price_minor)::int as snack_samples,percentile_disc(0.5) within group(order by r.snack_price_minor) filter(where r.snack_price_minor is not null) as snack_median_minor,count(r.drink_price_minor)::int as drink_samples,percentile_disc(0.5) within group(order by r.drink_price_minor) filter(where r.drink_price_minor is not null) as drink_median_minor,count(*) filter(where r.answers->>'purchaseFrequency'='never')::int as never_buy from vending_customers.responses r where ${where} group by r.currency order by r.currency`,
        )
      : Promise.resolve({ rows: [] }),
    db.execute(
      sql`select v.product,count(distinct r.id)::int as votes from ${table} r cross join lateral jsonb_array_elements_text(case when jsonb_typeof(r.answers->'productVariants')='array' then r.answers->'productVariants' else '[]'::jsonb end) v(product) where ${where} group by v.product order by votes desc,v.product`,
    ),
  ]);
  const rows = latest.rows as {
    id: string;
    created_at: Date;
    answers: Record<string, unknown>;
  }[];
  return {
    total: Number(counts.rows[0].total),
    variantResponses: Number(counts.rows[0].variant_responses),
    variants: variants.rows as { product: string; votes: number }[],
    responses: rows.slice(0, 30),
    nextCursor: rows.length > 30 ? rows[29].id : "",
    products: products.rows as {
      product: string;
      votes: number;
      first_choices: number;
    }[],
    prices: prices.rows as {
      currency: string;
      snack_samples: number;
      snack_median_minor: number | null;
      drink_samples: number;
      drink_median_minor: number | null;
      never_buy: number;
    }[],
  };
}

export async function reserveQuestionnaireLookup(fingerprint: string) {
  await questionnaireDb().execute(
    sql`select questionnaires_api.reserve_lookup(${fingerprint})`,
  );
}
