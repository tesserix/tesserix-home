"use client";
import { PRODUCTS, label, demandDecision } from "@tesserix/questionnaires";
import {
  ConsoleDataTable,
  type Column,
} from "@/components/kit/console-data-table";
type ProductVote = { product: string; votes: number; first_choices: number };
export function ProductShortlist({
  products,
  totalResponses,
}: {
  products: ProductVote[];
  totalResponses: number;
}) {
  const votes = new Map(products.map((p) => [p.product, p]));
  const rows = PRODUCTS.map(
    (product) => votes.get(product) ?? { product, votes: 0, first_choices: 0 },
  ).sort((a, b) => b.votes - a.votes || a.product.localeCompare(b.product));
  const columns: Column<ProductVote>[] = [
    { key: "product", header: "Product", cell: (r) => label(r.product) },
    { key: "votes", header: "Interested", cell: (r) => r.votes },
    {
      key: "share",
      header: "Share of responses",
      cell: (r) =>
        totalResponses
          ? `${Math.round((r.votes / totalResponses) * 100)}%`
          : "—",
    },
    { key: "first", header: "First choice", cell: (r) => r.first_choices },
    {
      key: "decision",
      header: "Suggested next step",
      cell: (r) => demandDecision(r.votes, totalResponses),
    },
  ];
  return (
    <ConsoleDataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.product}
      label="Product shortlist"
      total={rows.length}
      page={1}
      pageSize={rows.length}
      onPageChange={() => {}}
    />
  );
}
