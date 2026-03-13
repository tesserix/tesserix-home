import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const OPENFGA_API_URL =
  process.env.OPENFGA_API_URL || "http://localhost:8080";

interface FGAStore {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface TypeDefinition {
  type: string;
  relations?: Record<string, unknown>;
  metadata?: unknown;
}

interface AuthorizationModel {
  id: string;
  schema_version: string;
  type_definitions: TypeDefinition[];
}

async function fgaFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${OPENFGA_API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenFGA ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function GET() {
  // Verify user is authenticated
  const cookieStore = await cookies();
  if (!cookieStore.get("bff_home_session")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const storesData = await fgaFetch<{ stores: FGAStore[] }>("/stores");
    const stores = storesData.stores ?? [];

    // For each store, fetch the latest authorization model
    const storesWithModels = await Promise.all(
      stores.map(async (store) => {
        try {
          const modelData = await fgaFetch<{
            authorization_models: AuthorizationModel[];
          }>(`/stores/${store.id}/authorization-models?page_size=1`);

          const latestModel = modelData.authorization_models?.[0] ?? null;

          return {
            id: store.id,
            name: store.name,
            createdAt: store.created_at,
            updatedAt: store.updated_at,
            model: latestModel
              ? {
                  id: latestModel.id,
                  schemaVersion: latestModel.schema_version,
                  typeDefinitions: latestModel.type_definitions.map((td) => ({
                    type: td.type,
                    relations: td.relations
                      ? Object.keys(td.relations)
                      : [],
                    rawRelations: td.relations,
                  })),
                  typeCount: latestModel.type_definitions.length,
                }
              : null,
          };
        } catch {
          return {
            id: store.id,
            name: store.name,
            createdAt: store.created_at,
            updatedAt: store.updated_at,
            model: null,
          };
        }
      })
    );

    return NextResponse.json({
      stores: storesWithModels,
      totalStores: storesWithModels.length,
      totalTypes: storesWithModels.reduce(
        (sum, s) => sum + (s.model?.typeCount ?? 0),
        0
      ),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("ECONNREFUSED") || message.includes("fetch")) {
      return NextResponse.json(
        {
          error: "openfga_unreachable",
          message: `Cannot connect to OpenFGA at ${OPENFGA_API_URL}`,
          setupSteps: [
            "Ensure OpenFGA is deployed on Cloud Run",
            "Set OPENFGA_API_URL env var to the Cloud Run service URL",
            "Check that this service has network access to OpenFGA",
          ],
        },
        { status: 503 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
