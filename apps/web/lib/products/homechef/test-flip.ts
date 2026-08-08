import { GatewayError } from "./client";

// A blocked live→test flip answers 409 with `blockers: [...]` naming what is in
// the way. Only that shape may offer a force — a 500 or a dropped connection
// tells us nothing about the kitchen's state, and forcing on it would be
// forcing blind.
export function flipBlockersFrom(error: unknown): string[] | undefined {
  if (!(error instanceof GatewayError) || error.status !== 409) return undefined;
  const body = error.body;
  if (!body || typeof body !== "object" || !("blockers" in body)) return undefined;
  const blockers = (body as { blockers: unknown }).blockers;
  if (!Array.isArray(blockers) || blockers.length === 0) return undefined;
  return blockers.map(String);
}

// The copy an operator confirms before forcing. It names every blocker, because
// forcing without seeing what it parks is the mistake worth designing out.
export function forceFlipMessage(blockers: string[]): string {
  return (
    `This kitchen still has ${blockers.join(", ")}. ` +
    "Moving it to Test anyway parks that live work: nothing is deleted or changed, " +
    "but payouts stop releasing and meal-plan days stop generating until you move " +
    "the kitchen back to Live, when they resume by themselves."
  );
}
