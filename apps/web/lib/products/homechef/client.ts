// Browser-side client for HomeChef admin pages. Calls the same-origin signed
// gateway (`/api/admin/apps/homechef/gw/*`), which forwards to the Go `/admin/*`
// API. Use from "use client" components (pages) + the SWR fetcher below.
"use client";

const GW = "/api/admin/apps/homechef/gw";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
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
    throw new GatewayError(res.status, code);
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
  post<T>(adminPath: string, body?: unknown): Promise<T> {
    return fetch(buildUrl(adminPath), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then((r) => parse<T>(r));
  },
  delete<T>(adminPath: string): Promise<T> {
    return fetch(buildUrl(adminPath), { method: "DELETE", credentials: "include" }).then((r) =>
      parse<T>(r),
    );
  },
};

/** SWR fetcher: `useSWR(["/chefs", { status }], swrFetcher)`. */
export function swrFetcher<T>([adminPath, search]: [
  string,
  Record<string, string | number | undefined>?,
]): Promise<T> {
  return hcAdmin.get<T>(adminPath, search);
}
