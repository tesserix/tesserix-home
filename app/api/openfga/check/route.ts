import { NextRequest, NextResponse } from "next/server";

const OPENFGA_API_URL =
  process.env.OPENFGA_API_URL || "http://localhost:8080";

interface CheckRequestBody {
  storeId: string;
  tupleKey: {
    user: string;
    relation: string;
    object: string;
  };
}

export async function POST(req: NextRequest) {
  let body: CheckRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { storeId, tupleKey } = body;
  if (!storeId || !tupleKey?.user || !tupleKey?.relation || !tupleKey?.object) {
    return NextResponse.json(
      { error: "storeId, tupleKey.user, tupleKey.relation, tupleKey.object are required" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(
      `${OPENFGA_API_URL}/stores/${storeId}/check`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tuple_key: tupleKey }),
      }
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `OpenFGA check failed (${res.status}): ${errBody.slice(0, 300)}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json({ allowed: data.allowed ?? false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
