import { NextResponse } from "next/server";
import { getAccessToken, gcpFetch, GCP_PROJECT } from "@/lib/api/gcp";

interface BillingInfo {
  name: string;
  projectId: string;
  billingAccountName: string;
  billingEnabled: boolean;
}

interface BudgetAmount {
  specifiedAmount?: { units: string; currencyCode: string };
}

interface Budget {
  name: string;
  displayName: string;
  amount: BudgetAmount;
  budgetFilter?: { projects?: string[] };
}

export async function GET() {
  try {
    const token = await getAccessToken();

    // Step 1: Get billing account for the project
    const billingInfo = await gcpFetch<BillingInfo>(
      `https://cloudbilling.googleapis.com/v1/projects/${GCP_PROJECT}/billingInfo`,
      token
    );

    if (!billingInfo.billingEnabled || !billingInfo.billingAccountName) {
      return NextResponse.json({
        error: "billing_not_enabled",
        message: "Billing is not enabled for this project.",
        setupSteps: [
          "Go to GCP Console → Billing",
          "Link a billing account to this project",
          "Enable the Cloud Billing API",
          "Grant the service account roles/billing.viewer on the billing account",
        ],
      });
    }

    // Step 2: Attempt to list budgets for cost visibility
    const billingAccount = billingInfo.billingAccountName; // e.g. billingAccounts/XXXXXX
    let budgets: Budget[] = [];
    try {
      const budgetData = await gcpFetch<{ budgets?: Budget[] }>(
        `https://billingbudgets.googleapis.com/v1/${billingAccount}/budgets`,
        token
      );
      budgets = budgetData.budgets ?? [];
    } catch {
      // Budget API may not be enabled — not fatal
    }

    // Step 3: Return structured data
    // Real cost breakdowns require BigQuery billing export; surface what we can
    // and provide a mock-compatible structure so the UI works either way.
    const GCP_SERVICES = [
      { name: "Cloud Run", key: "run.googleapis.com" },
      { name: "Cloud SQL", key: "sqladmin.googleapis.com" },
      { name: "Secret Manager", key: "secretmanager.googleapis.com" },
      { name: "Pub/Sub", key: "pubsub.googleapis.com" },
      { name: "Cloud Storage", key: "storage.googleapis.com" },
      { name: "Cloud Tasks", key: "cloudtasks.googleapis.com" },
      { name: "Cloud Logging", key: "logging.googleapis.com" },
      { name: "Container Registry", key: "containerregistry.googleapis.com" },
    ];

    return NextResponse.json({
      billingAccount,
      billingEnabled: billingInfo.billingEnabled,
      budgets: budgets.map((b) => ({
        name: b.displayName || b.name,
        amount: b.amount?.specifiedAmount
          ? {
              value: parseFloat(b.amount.specifiedAmount.units || "0"),
              currency: b.amount.specifiedAmount.currencyCode,
            }
          : null,
      })),
      // BigQuery export required for real per-service breakdown
      services: GCP_SERVICES,
      bqExportRequired: true,
      bqSetupSteps: [
        "Enable BigQuery billing export in GCP Console → Billing → Billing export",
        "Create a dataset in BigQuery (e.g. billing_export)",
        "Set BILLING_BQ_DATASET env var to <project>.<dataset>.gcp_billing_export_v1_*",
        "Grant BigQuery Data Viewer to the service account",
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    // Provide helpful setup guidance when API access is missing
    if (message.includes("403") || message.includes("401")) {
      return NextResponse.json(
        {
          error: "insufficient_permissions",
          message:
            "The service account does not have permission to access billing data.",
          setupSteps: [
            "Grant roles/billing.viewer to the Cloud Run service account on the billing account",
            "Enable the Cloud Billing API: gcloud services enable cloudbilling.googleapis.com",
            "Enable the Billing Budgets API: gcloud services enable billingbudgets.googleapis.com",
          ],
        },
        { status: 403 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
