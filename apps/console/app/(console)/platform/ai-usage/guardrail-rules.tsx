// See page-header.tsx: @tesserix/web's barrel is "use client", so its table
// exports are `undefined` in a server component and React fails with #130.
"use client";

import { SurfaceStateView } from "@/components/kit/states";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@tesserix/web";
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
    <div className="rounded-lg border">
      <Table>
        <TableCaption className="sr-only">Guardrail rules that fired</TableCaption>
        <TableHeader className="bg-muted/50 text-xs uppercase">
          <TableRow>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Rule
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Action
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Product
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-right font-medium">
              Requests
            </TableHead>
            <TableHead scope="col" className="h-9 px-3 py-2 text-left font-medium">
              Last seen (UTC)
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule) => (
            <TableRow key={`${rule.rule}:${rule.action}:${rule.product}`} className="border-t">
              <TableCell className="px-3 py-2">{rule.rule}</TableCell>
              <TableCell className={`px-3 py-2 ${ACTION_COPY[rule.action].tone}`}>
                {ACTION_COPY[rule.action].label}
              </TableCell>
              <TableCell className="px-3 py-2">{rule.product}</TableCell>
              <TableCell className="px-3 py-2 text-right tabular-nums">
                {rule.requests.toLocaleString()}
              </TableCell>
              <TableCell className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                {eventTimeLabel(rule.lastSeen)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
