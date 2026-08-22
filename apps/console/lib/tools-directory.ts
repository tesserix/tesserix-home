// `server-only`: this module reads an operator's bearer token on one branch.
// A client component importing it must fail the build, not ship server code to
// the browser — see #299, and see the note in lib/search.ts about why the
// palette receives rows as a prop rather than importing this.
import "server-only";

import { INTERNAL_TOOLS, TOOL_GROUPS } from "@tesserix/console-core";
import { platformApiOrigin, platformRequestWithMeta } from "@/lib/platform-api";

/** One directory entry, in the console's own casing. */
export interface DirectoryTool {
  readonly id: string;
  readonly name: string;
  readonly subdomain: string;
  readonly purpose: string;
  readonly note: string | null;
  readonly groupKey: string;
}

/** One heading. */
export interface DirectoryGroup {
  readonly key: string;
  readonly label: string;
}

/**
 * Where the rendered directory came from.
 *
 * `builtin` is not an error state — it is the correct answer when
 * `PLATFORM_API_ORIGIN` is unset — but it IS a state the page tells the
 * operator about when the API was supposed to answer and did not. Two lists
 * that can disagree must never disagree silently.
 */
export type DirectorySource = "platform-api" | "builtin";

export interface ToolsDirectory {
  readonly groups: readonly DirectoryGroup[];
  readonly tools: readonly DirectoryTool[];
  readonly source: DirectorySource;
}

/**
 * The tools directory, from the platform API or from the code literal.
 *
 * Two backends behind one signature, chosen by `PLATFORM_API_ORIGIN` — the
 * same switch `fetchTickets` and the CRM queues use, and for the same reason:
 * UNSET IS BYTE-FOR-BYTE THE OLD BEHAVIOUR, so this phase reverts by removing
 * one variable rather than by reverting code.
 *
 * # Why a failure falls back instead of surfacing
 *
 * This is a directory of links, not a queue of work. An operator who cannot
 * reach Grafana because the console could not reach its own API is worse off
 * than one shown a slightly stale list — and the built-in list is not
 * plausibly stale by much, since it is the seed. So the failure is absorbed
 * and LABELLED rather than rendered as an error surface.
 *
 * That is a decision about THIS resource and does not generalise: a CRM queue
 * falling back to a hardcoded list would be indefensible. Per the rule at the
 * top of lib/crm-queues.ts, this is handled at the seam because the refusal
 * has an existing console-vocabulary equivalent — the built-in directory — so
 * neither error classifier needs to learn a new condition.
 */
export async function readToolsDirectory(): Promise<ToolsDirectory> {
  if (!platformApiOrigin()) {
    return builtin();
  }
  try {
    const [toolsBody, groupsBody] = await Promise.all([
      platformRequestWithMeta("tools directory", "/v1/platform/tools"),
      platformRequestWithMeta("tool groups", "/v1/platform/tool-groups"),
    ]);
    return parse(toolsBody.data, groupsBody.data);
  } catch (cause) {
    // Server-side only: this runs in a React Server Component, so it lands
    // in the app's logs and never in the response. The `[console]` prefix and
    // the bare console.* call are this app's convention — see
    // lib/db-read-error.ts:147; there is no logger module.
    console.warn("[console] the tools directory could not be read from the platform API", cause);
    return builtin();
  }
}

/** The code literal, which is also the seed migration 0031 applied. */
function builtin(): ToolsDirectory {
  return {
    groups: TOOL_GROUPS.map((group) => ({ key: group.key, label: group.label })),
    tools: INTERNAL_TOOLS.map((tool) => ({
      // The literal has no ids. A synthetic one keyed on the subdomain — which
      // is unique by construction — keeps React's keys stable without
      // pretending a database row exists.
      id: `builtin:${tool.subdomain}`,
      name: tool.name,
      subdomain: tool.subdomain,
      purpose: tool.purpose,
      note: tool.note ?? null,
      groupKey: tool.group,
    })),
    source: "builtin",
  };
}

/**
 * Turn the two payloads into the console's shape, or throw.
 *
 * Throwing is caught by the caller and becomes the labelled fallback. A
 * malformed success is a failure: a `tools` that is not an array would
 * otherwise reach the renderer and throw there, where the fallback cannot
 * catch it.
 */
function parse(toolsData: unknown, groupsData: unknown): ToolsDirectory {
  const rawGroups = arrayAt(groupsData, "groups");
  const rawTools = arrayAt(toolsData, "tools");

  const groups: DirectoryGroup[] = rawGroups.map((row) => ({
    key: str(row, "key"),
    label: str(row, "label"),
  }));
  const declared = new Set(groups.map((group) => group.key));

  const tools: DirectoryTool[] = rawTools
    .map((row) => ({
      id: str(row, "id"),
      name: str(row, "name"),
      subdomain: str(row, "subdomain"),
      purpose: str(row, "purpose"),
      note: nullableStr(row, "note"),
      groupKey: str(row, "group_key"),
    }))
    // A tool whose group is not declared would render as a card under no
    // heading. The foreign key makes it unreachable through the API; this is
    // the render-side belt, matching the one in internal-tools.tsx.
    .filter((tool) => declared.has(tool.groupKey));

  return { groups, tools, source: "platform-api" };
}

function arrayAt(data: unknown, key: string): Record<string, unknown>[] {
  const container = data as Record<string, unknown> | null;
  const value = container?.[key];
  if (!Array.isArray(value)) {
    throw new Error(`the tools directory payload has no \`${key}\` array`);
  }
  return value as Record<string, unknown>[];
}

function str(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`\`${key}\` is ${typeof value}, expected a string`);
  }
  return value;
}

function nullableStr(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`\`${key}\` is ${typeof value}, expected a string or null`);
  }
  return value;
}
