import { submitQuestionnaire } from "@tesserix/questionnaires/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ form: string }> },
) {
  return submitQuestionnaire(request, (await context.params).form);
}
