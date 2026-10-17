"use client";
import { label } from "@tesserix/questionnaires";
import {
  ConsoleDataTable,
  type Column,
} from "@/components/kit/console-data-table";
type Vote = { product: string; votes: number };
export function VariantShortlist({ products }: { products: Vote[] }) {
  const columns: Column<Vote>[] = [
    { key: "product", header: "Item / flavour", cell: (r) => label(r.product) },
    { key: "votes", header: "Interested submissions", cell: (r) => r.votes },
  ];
  return (
    <ConsoleDataTable
      state={{ kind: "ready" }}
      emptyMessage="No detailed item choices in this segment yet."
      columns={columns}
      rows={products}
      rowKey={(r) => r.product}
      label="Detailed item preferences"
      total={products.length}
      page={1}
      pageSize={Math.max(1, products.length)}
      onPageChange={() => {}}
    />
  );
}
