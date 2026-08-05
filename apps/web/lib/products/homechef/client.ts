// Browser-side client for HomeChef admin pages. Calls the same-origin signed
// gateway (`/api/admin/apps/homechef/gw/*`), which forwards to the Go `/admin/*`
// API. Use from "use client" components (pages) + the SWR fetcher below.
"use client";

const GW = "/api/admin/apps/homechef/gw";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /**
     * The full parsed error body. Some endpoints answer with more than a code —
     * a blocked chef mode flip returns 409 with `blockers: [...]` naming exactly
     * what is in the way — and the UI can only show that if it survives here.
     */
    readonly body?: unknown,
  ) {
    super(code);
    this.name = "GatewayError";
  }
}

function buildUrl(adminPath: string, search?: Record<string, string | number | undefined>): string {
  const path = adminPath.startsWith("/") ? adminPath : `/${adminPath}`;
  const qs = new URLSearchParams();
  if (search) {
    for (const [k, v] of Object.entries(search)) {
      if (v !== undefined && v !== "" && v !== null) qs.set(k, String(v));
    }
  }
  const q = qs.toString();
  return `${GW}${path}${q ? `?${q}` : ""}`;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const code = (data && typeof data === "object" && "error" in data && String(data.error)) || `http_${res.status}`;
    throw new GatewayError(res.status, code, data);
  }
  return data as T;
}

export const hcAdmin = {
  get<T>(adminPath: string, search?: Record<string, string | number | undefined>): Promise<T> {
    return fetch(buildUrl(adminPath, search), { credentials: "include" }).then((r) => parse<T>(r));
  },
  put<T>(adminPath: string, body?: unknown): Promise<T> {
    return fetch(buildUrl(adminPath), {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => parse<T>(r));
  },
  patch<T>(adminPath: string, body?: unknown): Promise<T> {
    return fetch(buildUrl(adminPath), {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => parse<T>(r));
  },
  post<T>(adminPath: string, body?: unknown): Promise<T> {
    return fetch(buildUrl(adminPath), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => parse<T>(r));
  },
  /** Multipart upload. Content-Type is deliberately UNSET: the browser has to
   *  set it so the multipart boundary goes with it, and naming it application/json
   *  the way the other verbs do would make the server reject the body. */
  postForm<T>(adminPath: string, form: FormData): Promise<T> {
    return fetch(buildUrl(adminPath), {
      method: "POST",
      credentials: "include",
      body: form,
    }).then((r) => parse<T>(r));
  },
  delete<T>(adminPath: string): Promise<T> {
    return fetch(buildUrl(adminPath), { method: "DELETE", credentials: "include" }).then((r) =>
      parse<T>(r),
    );
  },
};

/**
 * SWR fetcher: `useSWR(["/chefs", { status }], swrFetcher)`.
 *
 * The key MUST be a tuple. A bare string key type-checks — SWR's Key is loose
 * enough that TypeScript will not object — and then destructures CHARACTER-WISE:
 * `"/tax-rates"` becomes path `"/"` and search `"t"`, which requests `/gw?0=t`
 * and 404s with nothing to explain why. So reject it here rather than let a page
 * ship a silent empty state.
 */
export function swrFetcher<T>(key: [string, Record<string, string | number | undefined>?]): Promise<T> {
  if (typeof key === "string") {
    throw new Error(
      `swrFetcher: key must be a tuple, got the string "${key}". Use useSWR(["${key}"], swrFetcher).`,
    );
  }
  const [adminPath, search] = key;
  return hcAdmin.get<T>(adminPath, search);
}
