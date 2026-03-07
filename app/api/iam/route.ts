import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getAccessToken,
  gcpApi,
  GCP_PROJECT,
} from "@/lib/api/gcp";

// ─── GCP API Types ───

interface GCPServiceAccount {
  name: string;
  projectId: string;
  uniqueId: string;
  email: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
}

interface GCPServiceAccountsResponse {
  accounts?: GCPServiceAccount[];
}

interface IamBinding {
  role: string;
  members: string[];
}

interface IamPolicyResponse {
  bindings?: IamBinding[];
}

// ─── Response Types ───

export interface ServiceAccountEntry {
  email: string;
  displayName: string;
  description: string;
  disabled: boolean;
  roles: string[];
}

export interface IamOverviewResponse {
  serviceAccounts: ServiceAccountEntry[];
  totalRoles: number;
}

// ─── Handler ───

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = await getAccessToken();

    // Fetch all service accounts for the project
    const saResponse = await gcpApi<GCPServiceAccountsResponse>(
      `iam.googleapis.com/v1/projects/${GCP_PROJECT}/serviceAccounts`,
      token
    );

    const allAccounts = saResponse.accounts ?? [];

    // Filter to project-managed SAs only
    const projectSuffix = `@${GCP_PROJECT}.iam.gserviceaccount.com`;
    const projectAccounts = allAccounts.filter((sa) =>
      sa.email.endsWith(projectSuffix)
    );

    // Fetch IAM policy for the project (single call — more efficient than per-SA)
    const policyResponse = await gcpApi<IamPolicyResponse>(
      `cloudresourcemanager.googleapis.com/v1/projects/${GCP_PROJECT}:getIamPolicy`,
      token,
      { method: "POST", body: JSON.stringify({}) }
    );

    const bindings = policyResponse.bindings ?? [];

    // Build a map: member → roles[]
    const memberRoles = new Map<string, string[]>();
    for (const binding of bindings) {
      for (const member of binding.members) {
        const existing = memberRoles.get(member) ?? [];
        existing.push(binding.role);
        memberRoles.set(member, existing);
      }
    }

    const serviceAccounts: ServiceAccountEntry[] = projectAccounts.map((sa) => {
      const memberKey = `serviceAccount:${sa.email}`;
      const roles = memberRoles.get(memberKey) ?? [];
      return {
        email: sa.email,
        displayName: sa.displayName ?? "",
        description: sa.description ?? "",
        disabled: sa.disabled ?? false,
        roles,
      };
    });

    // Count unique roles across all SAs
    const uniqueRoles = new Set(serviceAccounts.flatMap((sa) => sa.roles));

    const response: IamOverviewResponse = {
      serviceAccounts,
      totalRoles: uniqueRoles.size,
    };

    return NextResponse.json({ data: response });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch IAM data";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
