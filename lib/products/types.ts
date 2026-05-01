// Per-product configuration consumed by the Resources/Cost dashboards.
// Adding a new product (HomeChef, FanZone, …) is a config-only change:
// add an entry to lib/products/configs.ts. No layout code changes.

export interface KpiTileSpec {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly href?: string;
  readonly source: "platform" | "product";
}

export interface RowCountTable {
  readonly label: string;
  readonly tableName: string;
  readonly database: "platform_api" | "marketplace_api";
}

export interface CostAttributionWeights {
  readonly requests: number;
  readonly storage: number;
  readonly egress: number;
}

export interface ProductConfig {
  readonly id: string;
  readonly name: string;
  readonly namespace: string;
  readonly cnpgClusterName: string;
  readonly sendGridProductTag: string;
  readonly rowCountTables: ReadonlyArray<RowCountTable>;
  readonly costAttribution: CostAttributionWeights;
  readonly businessKpiTiles: ReadonlyArray<KpiTileSpec>;
}
