import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

async function ghFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * GitHub secrets are encrypted with the repo's public key using libsodium.
 * We use tweetnacl (compatible) for the encryption.
 */
async function encryptSecret(publicKey: string, secretValue: string): Promise<string> {
  // Dynamic import for server-side only
  const nacl = (await import("tweetnacl")) as any;
  const tweetnaclUtil = (await import("tweetnacl-util")) as any;

  const keyBytes = tweetnaclUtil.decodeBase64(publicKey);
  const messageBytes = new TextEncoder().encode(secretValue);
  const encrypted = nacl.sealedbox
    ? nacl.sealedbox.seal(messageBytes, keyBytes)
    : nacl.default.box.seal(messageBytes, keyBytes);

  // Buffer.from for base64 encoding
  return Buffer.from(encrypted).toString("base64");
}

/**
 * POST /api/secrets/update
 * Body: { repo: "tesserix/auth-bff", name: "SECRET_NAME", value: "secret_value" }
 *
 * Creates or updates a GitHub Actions secret.
 */
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { repo, name, value } = (await request.json()) as {
      repo: string;
      name: string;
      value: string;
    };

    if (!repo || !name || !value) {
      return NextResponse.json(
        { error: "repo, name, and value are required" },
        { status: 400 }
      );
    }

    const [owner, repoName] = repo.split("/");

    // Get the repo's public key for secret encryption
    const keyData = await ghFetch<{ key_id: string; key: string }>(
      `/repos/${owner}/${repoName}/actions/secrets/public-key`
    );

    // Encrypt the secret value
    const encryptedValue = await encryptSecret(keyData.key, value);

    // Create or update the secret
    await ghFetch(`/repos/${owner}/${repoName}/actions/secrets/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyData.key_id,
      }),
    });

    return NextResponse.json({ success: true, repo, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update secret";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/**
 * DELETE /api/secrets/update
 * Body: { repo: "tesserix/auth-bff", name: "SECRET_NAME" }
 */
export async function DELETE(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { repo, name } = (await request.json()) as {
      repo: string;
      name: string;
    };

    if (!repo || !name) {
      return NextResponse.json(
        { error: "repo and name are required" },
        { status: 400 }
      );
    }

    const [owner, repoName] = repo.split("/");

    await ghFetch(`/repos/${owner}/${repoName}/actions/secrets/${name}`, {
      method: "DELETE",
    });

    return NextResponse.json({ success: true, repo, name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete secret";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
