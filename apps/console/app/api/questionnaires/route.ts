import { isFormId, VENUES } from "@tesserix/questionnaires";
import { readQuestionnaireReport } from "@tesserix/questionnaires/server";
import { requireQuestionnaireViewer } from "@/lib/questionnaires/access";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireQuestionnaireViewer();
  } catch {
    return Response.json(
      { error: { code: "not_found", message: "Not found" } },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const q = new URL(request.url).searchParams;
  const form = q.get("form") ?? "vending-customers";
  const venue = q.get("venue") ?? "";
  const country = q.get("country") ?? "";
  const campaign = q.get("campaign") ?? "";
  const region = q.get("region")?.trim() ?? "";
  const after = q.get("after") ?? "0";
  if (
    !isFormId(form) ||
    (venue && !(VENUES as readonly string[]).includes(venue)) ||
    (country && !/^[A-Z]{2}$/.test(country)) ||
    campaign.length > 200 ||
    region.length > 200 ||
    !/^[0-9]{1,18}$/.test(after) ||
    [...q.keys()].some(
      (k) =>
        !["form", "venue", "country", "campaign", "region", "after"].includes(
          k,
        ),
    )
  )
    return Response.json(
      { error: { code: "invalid_filter", message: "Invalid report filter" } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  try {
    return Response.json(
      await readQuestionnaireReport(
        form,
        { venue, country, campaign, region },
        after,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "unavailable",
          message: "Questionnaire reporting unavailable",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
