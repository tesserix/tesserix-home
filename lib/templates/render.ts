// Server-side template renderer for tesserix-home-owned templates
// (currently: B2 lead-marketing templates).
//
// Mirrors Go's text/template semantics for the {{ .Field }} interpolation
// pattern with `if` blocks. We deliberately keep the supported syntax
// minimal — the same templates are written + previewed here, but in
// principle could be ported to a Go renderer later (e.g. if a worker
// outside tesserix-home picks up bulk-send) and we don't want to drift
// into a feature set Go can't match.
//
// Supported syntax:
//   {{.Field}}                         — interpolate a field
//   {{if .Field}}…{{else}}…{{end}}     — conditional block (truthy: non-empty
//                                        string, non-zero number, true)
//
// Unsupported (intentional): pipelines, range, define, function calls.
//
// HTML mode escapes interpolated values; text mode doesn't.

const FIELD_RE = /\{\{\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const IF_BLOCK_RE = /\{\{\s*if\s+\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}([\s\S]*?)(?:\{\{\s*else\s*\}\}([\s\S]*?))?\{\{\s*end\s*\}\}/g;

export type RenderMode = "html" | "text";

export interface RenderResult {
  readonly ok: boolean;
  readonly output: string;
  readonly errorMessage: string | null;
}

export interface RenderOptions {
  readonly mode: RenderMode;
}

export function render(
  template: string,
  vars: Record<string, unknown>,
  opts: RenderOptions,
): RenderResult {
  try {
    let out = template;
    // Resolve `if` blocks first so the field interpolation pass doesn't
    // hit interpolations inside inactive branches.
    out = out.replace(IF_BLOCK_RE, (_, field: string, ifBody: string, elseBody: string | undefined) => {
      const v = vars[field];
      const truthy = isTruthy(v);
      return truthy ? ifBody : elseBody ?? "";
    });
    // Now interpolate fields.
    out = out.replace(FIELD_RE, (match, field: string) => {
      const v = vars[field];
      if (v === undefined || v === null) return "";
      const s = String(v);
      return opts.mode === "html" ? htmlEscape(s) : s;
    });
    return { ok: true, output: out, errorMessage: null };
  } catch (err) {
    return {
      ok: false,
      output: "",
      errorMessage: err instanceof Error ? err.message : "render error",
    };
  }
}

function isTruthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
