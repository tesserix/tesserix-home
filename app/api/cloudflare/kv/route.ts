import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID || "";

const KV_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}`;

function cfHeaders() {
  return {
    Authorization: `Bearer ${CF_API_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function cfFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...cfHeaders(),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Cloudflare API ${res.status}: ${body.slice(0, 300)}`);
  }
  // Value endpoint returns plain text, not JSON
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text() as unknown as T;
}

// ─── GET /api/cloudflare/kv ───
// ?key=xxx → get single value
// (no key)  → list all keys

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const key = request.nextUrl.searchParams.get("key");

    if (key) {
      const value = await cfFetch<string>(
        `${KV_BASE}/values/${encodeURIComponent(key)}`
      );
      return NextResponse.json({ data: { key, value } });
    }

    // List all keys (paginate up to 1000)
    interface CfKey { name: string; expiration?: number; metadata?: unknown }
    interface CfListResponse { result: CfKey[]; result_info: { cursor?: string; count: number } }

    const allKeys: CfKey[] = [];
    let cursor: string | undefined;

    do {
      const url = new URL(`${KV_BASE}/keys`);
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);

      const page = await cfFetch<CfListResponse>(url.toString());
      allKeys.push(...page.result);
      cursor = page.result_info.cursor;
    } while (cursor);

    const keys = allKeys.map((k) => ({
      key: k.name,
      expiration: k.expiration ?? null,
    }));

    return NextResponse.json({ data: keys });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch KV data";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// ─── PUT /api/cloudflare/kv ───
// Body: { key: string; value: string }

export async function PUT(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { key, value } = (await request.json()) as { key: string; value: string };
    if (!key || value === undefined) {
      return NextResponse.json({ error: "key and value are required" }, { status: 400 });
    }

    await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${CF_API_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: value,
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Cloudflare API ${res.status}: ${body.slice(0, 300)}`);
      }
    });

    return NextResponse.json({ success: true, key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update KV value";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

// ─── DELETE /api/cloudflare/kv ───
// Body: { key: string }

export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { key } = (await request.json()) as { key: string };
    if (!key) {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }

    await fetch(`${KV_BASE}/values/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Cloudflare API ${res.status}: ${body.slice(0, 300)}`);
      }
    });

    return NextResponse.json({ success: true, key });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete KV key";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
