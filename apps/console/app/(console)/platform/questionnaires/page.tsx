import { ProductShortlist } from "@/components/questionnaires/product-shortlist";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  FORM_IDS,
  VENUES,
  forms,
  isFormId,
  label,
} from "@tesserix/questionnaires";
import { readQuestionnaireReport } from "@tesserix/questionnaires/server";
import { requireQuestionnaireViewer } from "@/lib/questionnaires/access";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    await requireQuestionnaireViewer();
  } catch {
    notFound();
  }
  const query = await searchParams;
  const form =
    typeof query.form === "string" && isFormId(query.form)
      ? query.form
      : "vending-customers";
  const venue =
    typeof query.venue === "string" &&
    (VENUES as readonly string[]).includes(query.venue)
      ? query.venue
      : "";
  const country =
    typeof query.country === "string" && /^[A-Z]{2}$/.test(query.country)
      ? query.country
      : "";
  const campaign =
    typeof query.campaign === "string" ? query.campaign.slice(0, 200) : "";
  const after =
    typeof query.after === "string" && /^[0-9]{1,18}$/.test(query.after)
      ? query.after
      : "0";
  let report;
  try {
    report = await readQuestionnaireReport(
      form,
      { venue, country, campaign },
      after,
    );
  } catch {
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold">Questionnaires</h1>
        <p role="alert">
          Questionnaire reporting is temporarily unavailable. No responses have
          been changed. Please try again later.
        </p>
      </section>
    );
  }
  const params = new URLSearchParams({ form, venue, country, campaign });
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold">Questionnaires</h1>
        <p className="text-muted-foreground">
          Vending research: product demand, venue enquiries and the evidence
          behind a pilot.
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        {FORM_IDS.map((id) => (
          <div key={id} className="space-y-3 rounded-xl border p-5">
            <h2 className="font-semibold">{forms[id].title}</h2>
            <p className="text-sm text-muted-foreground">
              {forms[id].audience}
            </p>
            <a
              href={`https://questionnaire.tesserix.app/${id}`}
              target="_blank"
              rel="noreferrer"
              className="break-all text-sm underline"
            >
              questionnaire.tesserix.app/{id}
            </a>
            <p>
              <Link
                href={`?form=${id}`}
                className="text-sm font-medium underline"
              >
                View responses →
              </Link>
            </p>
          </div>
        ))}
      </div>
      <form
        method="get"
        className="flex flex-wrap items-end gap-4 rounded-xl border p-5"
      >
        <input type="hidden" name="form" value={form} />
        <label className="space-y-1 text-sm">
          Venue type
          <select
            name="venue"
            defaultValue={venue}
            className="block rounded-lg border bg-background p-2"
          >
            <option value="">All venues</option>
            {VENUES.map((v) => (
              <option key={v} value={v}>
                {label(v)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Country code
          <input
            name="country"
            defaultValue={country}
            maxLength={2}
            pattern="[A-Z]{2}"
            placeholder="AU"
            className="block w-28 rounded-lg border bg-background p-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          Campaign / location code
          <input
            name="campaign"
            defaultValue={campaign}
            maxLength={200}
            className="block rounded-lg border bg-background p-2"
          />
        </label>
        <button className="rounded-lg border px-4 py-2 text-sm">
          Apply filters
        </button>
      </form>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">
          {report.total}{" "}
          {form === "vending-customers" ? "customer" : "business"} responses
        </h2>
        <p className="text-sm text-muted-foreground">
          Counts are submissions, not verified unique people. Apply location
          filters before comparing demand. Optional answers can be missing; a
          blank price is not zero.
        </p>
      </section>
      {form === "vending-customers" && (
        <>
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">Product shortlist</h2>
            <p className="text-sm text-muted-foreground">
              Exploratory rule: collect at least 30 responses per segment;
              interest of 30% or more suggests a small pilot, 10–29% a limited
              test, and below 10% lower priority. These thresholds are planning
              rules, not sales predictions. Check margin, expiry, storage,
              supplier minimums and actual pilot sales before purchasing stock.
            </p>
            <ProductShortlist
              products={report.products}
              totalResponses={report.total}
            />
          </section>
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Price sensitivity</h2>
            <p className="text-sm text-muted-foreground">
              Median stated maximum per item, separated by currency. This is not
              an optimal selling price. Zero means unwilling to pay; blank
              answers are excluded.
            </p>
            {report.prices.length === 0 ? (
              <p className="text-sm">No price responses yet.</p>
            ) : (
              report.prices.map((p) => (
                <div key={p.currency} className="rounded-xl border p-4 text-sm">
                  <strong>{p.currency}</strong> · Snack median:{" "}
                  {p.snack_median_minor === null
                    ? "—"
                    : (Number(p.snack_median_minor) / 100).toFixed(2)}{" "}
                  ({p.snack_samples} answers) · Drink median:{" "}
                  {p.drink_median_minor === null
                    ? "—"
                    : (Number(p.drink_median_minor) / 100).toFixed(2)}{" "}
                  ({p.drink_samples} answers) · Would never buy: {p.never_buy}
                </div>
              ))
            )}
          </section>
        </>
      )}
      {form === "vending-business" && (
        <aside className="rounded-xl border p-5 text-sm">
          Before shortlisting a site, confirm measured footfall at the proposed
          position, decision-maker authority, total rent and electricity cost,
          continuous power, connectivity, secure servicing access, insurance,
          accessibility and local food-business approvals. “Unknown” answers
          require follow-up; a survey response is not an approved installation.
        </aside>
      )}
      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Latest responses</h2>
        {report.responses.length === 0 ? (
          <p>No responses match these filters.</p>
        ) : (
          report.responses.map((r) => (
            <details key={r.id} className="rounded-xl border p-4">
              <summary className="cursor-pointer text-sm">
                {new Date(r.created_at).toLocaleString("en-AU", {
                  timeZone: "Australia/Melbourne",
                })}{" "}
                ·{" "}
                {String(
                  r.answers.venueName ||
                    r.answers.businessName ||
                    r.answers.city,
                )}{" "}
                · {label(String(r.answers.venueType))}
              </summary>
              <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                {forms[form].fields.map((f) => (
                  <div key={f.key}>
                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {Array.isArray(r.answers[f.key])
                        ? (r.answers[f.key] as string[])
                            .map(label)
                            .join(", ") || "No selection"
                        : r.answers[f.key] === undefined ||
                            r.answers[f.key] === ""
                          ? "Not provided"
                          : String(r.answers[f.key])}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))
        )}
        {report.nextCursor && (
          <Link
            className="inline-block rounded-lg border px-4 py-2 text-sm"
            href={`?${params}&after=${report.nextCursor}`}
          >
            Older responses →
          </Link>
        )}
      </section>
    </div>
  );
}
