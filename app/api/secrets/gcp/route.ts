import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const GCP_PROJECT = process.env.GCP_PROJECT_ID || "tesserix";

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error("Failed to get GCP access token");
  const { access_token } = await res.json();
  return access_token;
}

async function smFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GCP Secret Manager ${res.status}: ${body.slice(0, 200)}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * GET /api/secrets/gcp — List all GCP secrets
 * GET /api/secrets/gcp?name=secret-name — Get a specific secret's latest version value
 */
export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = await getAccessToken();
    const secretName = request.nextUrl.searchParams.get("name");

    // Get specific secret value
    if (secretName) {
      const data = await smFetch<{ payload: { data: string } }>(
        `/projects/${GCP_PROJECT}/secrets/${secretName}/versions/latest:access`,
        token
      );
      const decoded = Buffer.from(data.payload.data, "base64").toString("utf-8");
      return NextResponse.json({
        data: {
          name: secretName,
          value: decoded,
        },
      });
    }

    // List all secrets
    const data = await smFetch<{
      secrets: Array<{
        name: string;
        createTime: string;
        labels?: Record<string, string>;
      }>;
    }>(`/projects/${GCP_PROJECT}/secrets?pageSize=100`, token);

    const secrets = (data.secrets || []).map((s) => {
      // name format: projects/PROJECT/secrets/SECRET_NAME
      const shortName = s.name.split("/").pop() || s.name;
      return {
        name: shortName,
        fullName: s.name,
        createdAt: s.createTime,
        labels: s.labels || {},
      };
    });

    return NextResponse.json({ data: secrets });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch GCP secrets";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * POST /api/secrets/gcp — Create or update a GCP secret
 * Body: { name: "secret-name", value: "secret-value" }
 */
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name, value } = (await request.json()) as { name: string; value: string };
    if (!name || !value) {
      return NextResponse.json({ error: "name and value are required" }, { status: 400 });
    }

    const token = await getAccessToken();
    const encoded = Buffer.from(value).toString("base64");

    // Try to add a new version (secret already exists)
    try {
      await smFetch(
        `/projects/${GCP_PROJECT}/secrets/${name}:addVersion`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ payload: { data: encoded } }),
        }
      );
      return NextResponse.json({ success: true, name, action: "updated" });
    } catch {
      // Secret doesn't exist — create it first
      await smFetch(`/projects/${GCP_PROJECT}/secrets`, token, {
        method: "POST",
        body: JSON.stringify({
          secretId: name,
          replication: { automatic: {} },
        }),
      });

      // Add the first version
      await smFetch(
        `/projects/${GCP_PROJECT}/secrets/${name}:addVersion`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ payload: { data: encoded } }),
        }
      );
      return NextResponse.json({ success: true, name, action: "created" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update GCP secret";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * DELETE /api/secrets/gcp — Delete a GCP secret
 * Body: { name: "secret-name" }
 */
export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name } = (await request.json()) as { name: string };
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const token = await getAccessToken();
    await smFetch(`/projects/${GCP_PROJECT}/secrets/${name}`, token, {
      method: "DELETE",
    });

    return NextResponse.json({ success: true, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete GCP secret";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
