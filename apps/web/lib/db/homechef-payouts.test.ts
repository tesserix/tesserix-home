import { beforeEach, describe, expect, it, vi } from "vitest";

const homechefQuery = vi.fn();
vi.mock("@/lib/db/homechef", () => ({
  homechefQuery: (sql: string, params: unknown[]) => homechefQuery(sql, params),
  homechefTx: vi.fn(),
}));

const { listStatements, listStatementsForExport } = await import("./homechef-payouts");

// Every column weekly_statements actually has (Home-Chef-App
// models/statement.go). The admin payouts page returned HTTP 500 in production
// because the SELECT named recovery_deductions, a column #1092 has not shipped
// yet — Postgres rejects the whole query, so the operator saw no statements at
// all. Anything selected off `s.` must exist here.
const WEEKLY_STATEMENT_COLUMNS = new Set([
  "id", "chef_id", "user_id", "week_start", "week_end", "currency",
  "orders_count", "gross_revenue", "platform_commission", "cgst", "sgst",
  "igst", "tds", "penalty_deductions", "bonus_additions", "net_payout",
  "status", "paid_at", "payout_ref", "created_at",
]);

function selectedStatementColumns(sql: string): string[] {
  return [...sql.matchAll(/\bs\.([a-z_]+)/g)].map((m) => m[1]!);
}

beforeEach(() => {
  homechefQuery.mockReset();
  homechefQuery.mockResolvedValue({ rows: [] });
});

describe("weekly-statement queries", () => {
  it("only reads columns weekly_statements has", async () => {
    await listStatements({});
    await listStatementsForExport({ status: "pending", week: "2026-08-03" });

    for (const [sql] of homechefQuery.mock.calls) {
      for (const col of selectedStatementColumns(sql as string)) {
        expect(WEEKLY_STATEMENT_COLUMNS).toContain(col);
      }
    }
  });

  it("reports the penalty and bonus adjustments that move net payout", async () => {
    homechefQuery.mockResolvedValue({
      rows: [
        {
          id: "s-1",
          chef_id: "c-1",
          chef_name: "Saffron Home Kitchen",
          week_start: "2026-08-03T00:00:00.000Z",
          week_end: "2026-08-10T00:00:00.000Z",
          currency: "INR",
          orders_count: "4",
          gross_revenue: "2000",
          platform_commission: "300",
          cgst: "0",
          sgst: "0",
          igst: "0",
          tds: "20",
          penalty_deductions: "150.50",
          bonus_additions: "75.25",
          net_payout: "1604.75",
          status: "pending",
          paid_at: null,
          payout_ref: null,
          created_at: "2026-08-10T01:00:00.000Z",
        },
      ],
    });

    const [row] = await listStatements({});

    expect(row?.penalty_deductions).toBe(150.5);
    expect(row?.bonus_additions).toBe(75.25);
    expect(row?.net_payout).toBe(1604.75);
  });

  it("treats a statement with no adjustments as zero, not null", async () => {
    homechefQuery.mockResolvedValue({
      rows: [{ id: "s-2", chef_id: "c-2", penalty_deductions: null, bonus_additions: null }],
    });

    const [row] = await listStatements({});

    expect(row?.penalty_deductions).toBe(0);
    expect(row?.bonus_additions).toBe(0);
  });
});
