import { NextRequest, NextResponse } from "next/server";

/**
 * Sync is a no-op in the new infra.
 * Cloud Run services deploy automatically via CI/CD (GitHub Actions → _deploy-cloudrun.yml).
 * This endpoint is kept for API compatibility with the releases UI.
 */
export async function POST(_request: NextRequest) {
  return NextResponse.json({
    success: true,
    message: "Cloud Run services deploy automatically via CI/CD. No manual sync needed.",
  });
}
