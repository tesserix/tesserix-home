import { SurfaceStateView } from "@/components/kit/states";
import type { SurfaceState } from "@/components/kit/surface-state";
import type { GuardrailRule } from "@/lib/ai-usage";
import { eventTimeLabel } from "./events-table";

/**
 * Which prompt-guard rules fired, and on whose traffic.
 *
 * `reject` and `mask` are very different events and are labelled as such: a
 * rejected request never reached a provider, a masked one did with the match
 * removed. Counting them together would report a refusal rate that is not one.
 */

const ACTION_COPY = {
  reject: { label: "Rejected", tone: "text-destructive" },
  mask: { label: "Masked", tone: "text-muted-foreground" },
} as const;

export interface GuardrailRulesProps {
  rules: readonly GuardrailRule[];
  state: SurfaceState;
  emptyMessage: string;
}

export function GuardrailRules({ rules, state, emptyMessage }: GuardrailRulesProps) {
  if (state.kind !== "ready") {
    return <SurfaceStateView state={state} emptyMessage={emptyMessage} />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Guardrail rules that fired</caption>
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Rule
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Action
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Product
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Requests
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Last seen (UTC)
            </th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={`${rule.rule}:${rule.action}:${rule.product}`} className="border-t">
              <td className="px-3 py-2">{rule.rule}</td>
              <td className={`px-3 py-2 ${ACTION_COPY[rule.action].tone}`}>
                {ACTION_COPY[rule.action].label}
              </td>
              <td className="px-3 py-2">{rule.product}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {rule.requests.toLocaleString()}
              </td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                {eventTimeLabel(rule.lastSeen)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
