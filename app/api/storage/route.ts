import { NextRequest, NextResponse } from "next/server";
import { getAccessToken, gcpFetch } from "@/lib/api/gcp";

const DEFAULT_BUCKET = process.env.GCS_BUCKET || "";

interface GCSObject {
  name: string;
  size: string;
  contentType: string;
  updated: string;
  timeCreated: string;
  md5Hash?: string;
  storageClass: string;
  id: string;
}

interface GCSListResponse {
  kind: string;
  nextPageToken?: string;
  prefixes?: string[];
  items?: GCSObject[];
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const bucket = searchParams.get("bucket") || DEFAULT_BUCKET;
  const prefix = searchParams.get("prefix") || "";
  const pageToken = searchParams.get("pageToken") || "";

  if (!bucket) {
    return NextResponse.json(
      {
        error: "no_bucket",
        message: "No GCS bucket configured.",
        setupSteps: [
          "Set the GCS_BUCKET env var on the Cloud Run service",
          "Example: GCS_BUCKET=your-bucket-name",
        ],
      },
      { status: 400 }
    );
  }

  try {
    const token = await getAccessToken();

    const params = new URLSearchParams({ delimiter: "/" });
    if (prefix) params.set("prefix", prefix);
    if (pageToken) params.set("pageToken", pageToken);

    const data = await gcpFetch<GCSListResponse>(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?${params.toString()}`,
      token
    );

    const folders = (data.prefixes ?? []).map((p) => ({
      type: "folder" as const,
      name: p,
      // Show only the last path segment as display name
      displayName: p.replace(prefix, "").replace(/\/$/, ""),
    }));

    const files = (data.items ?? []).map((item) => ({
      type: "file" as const,
      name: item.name,
      displayName: item.name.replace(prefix, ""),
      size: parseInt(item.size || "0", 10),
      contentType: item.contentType || "application/octet-stream",
      updated: item.updated,
      timeCreated: item.timeCreated,
      storageClass: item.storageClass,
    }));

    return NextResponse.json({
      bucket,
      prefix,
      folders,
      files,
      nextPageToken: data.nextPageToken,
      totalObjects: folders.length + files.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("403") || message.includes("401")) {
      return NextResponse.json(
        {
          error: "insufficient_permissions",
          message: "The service account does not have access to this GCS bucket.",
          setupSteps: [
            "Grant roles/storage.objectViewer to the Cloud Run service account",
            "Run: gcloud storage buckets add-iam-policy-binding gs://BUCKET --member=serviceAccount:SA_EMAIL --role=roles/storage.objectViewer",
          ],
        },
        { status: 403 }
      );
    }

    if (message.includes("404")) {
      return NextResponse.json(
        { error: "bucket_not_found", message: `Bucket "${bucket}" not found.` },
        { status: 404 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
