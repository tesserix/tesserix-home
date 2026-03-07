import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAccessToken, gcpFetch, GCP_PROJECT } from "@/lib/api/gcp";

// ─── Types ───

interface SqlInstance {
  name: string;
  databaseVersion: string;
  state: string;
  region: string;
  gceZone?: string;
  ipAddresses?: Array<{ ipAddress: string; type: string }>;
  settings?: {
    tier?: string;
    backupConfiguration?: { enabled?: boolean };
    storageAutoResize?: boolean;
    dataDiskSizeGb?: string;
    availabilityType?: string;
  };
}

interface SqlDatabase {
  name: string;
  instance: string;
  charset?: string;
  collation?: string;
}

interface SqlInstancesResponse {
  items?: SqlInstance[];
}

interface SqlDatabasesResponse {
  items?: SqlDatabase[];
}

// ─── GET /api/cloud-sql ───

export async function GET() {
  try {
    const cookieStore = await cookies();
    if (!cookieStore.get("bff_home_session")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = await getAccessToken();
    const base = `sqladmin.googleapis.com/v1/projects/${GCP_PROJECT}`;

    // List all instances
    const instancesData = await gcpFetch<SqlInstancesResponse>(
      `https://${base}/instances`,
      token
    );

    const rawInstances = instancesData.items || [];

    // Fetch databases for each instance in parallel
    const instancesWithDbs = await Promise.all(
      rawInstances.map(async (inst) => {
        let databases: Array<{ name: string; charset?: string }> = [];
        try {
          const dbData = await gcpFetch<SqlDatabasesResponse>(
            `https://${base}/instances/${inst.name}/databases`,
            token
          );
          databases = (dbData.items || [])
            .filter((d) => !["postgres", "cloudsqladmin", "template0", "template1"].includes(d.name))
            .map((d) => ({ name: d.name, charset: d.charset }));
        } catch {
          // non-fatal — some states may not allow listing databases
        }

        return {
          name: inst.name,
          databaseVersion: inst.databaseVersion || "UNKNOWN",
          state: inst.state || "UNKNOWN",
          region: inst.region || GCP_PROJECT,
          tier: inst.settings?.tier || "unknown",
          storageGb: inst.settings?.dataDiskSizeGb
            ? parseInt(inst.settings.dataDiskSizeGb, 10)
            : null,
          storageAutoResize: inst.settings?.storageAutoResize ?? false,
          backupEnabled: inst.settings?.backupConfiguration?.enabled ?? false,
          availabilityType: inst.settings?.availabilityType || "ZONAL",
          ipAddresses: (inst.ipAddresses || []).map((ip) => ({
            address: ip.ipAddress,
            type: ip.type,
          })),
          databases,
        };
      })
    );

    return NextResponse.json({ data: instancesWithDbs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch Cloud SQL instances";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
