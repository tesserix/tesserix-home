import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { questionnaireDb, readQuestionnaireReport } from "./server";
vi.mock("server-only", () => ({}));
it("isolates region totals, detailed demand, prices and response pages for both forms", async () => {
  if (
    process.env.QUESTIONNAIRES_DB_LOCAL !== "true" ||
    process.env.QUESTIONNAIRES_DB_HOST !== "127.0.0.1"
  )
    throw new Error("A disposable local database is required");
  const db = questionnaireDb();
  const campaign = `report-test-${crypto.randomUUID()}`;
  const fingerprint = createHash("sha256").update(campaign).digest("hex");
  try {
    for (const form of ["vending-customers", "vending-business"] as const) {
      const common = {
        version: 1,
        consent: true,
        website: "",
        country: "IN",
        currency: "INR",
        city: "Bhubaneswar",
        venueType: "hospital",
        campaign,
        paymentMethods: ["card"],
        visitFrequency: "weekly",
        purchaseFrequency: "weekly",
        businessName: "Synthetic hospital",
        authority: "researching",
        footfall: "unknown",
        power: "unknown",
        internet: "unknown",
        commercialModel: "not-interested",
      };
      for (const region of ["Odisha", "Gujarat"]) {
        const answers = {
          ...common,
          region,
          products: ["coffee-tea"],
          topProduct: "coffee-tea",
          requestedProducts: ["coffee-tea"],
          productVariants:
            region === "Odisha" ? ["masala-chai"] : ["black-tea"],
          maxDrinkPrice: region === "Odisha" ? 20 : 40,
        };
        await db.execute(
          sql`select questionnaires_api.submit(${form},${crypto.randomUUID()}::uuid,${JSON.stringify(answers)}::jsonb,${fingerprint},null,${region === "Odisha" ? 2000 : 4000})`,
        );
      }
      const report = await readQuestionnaireReport(form, {
        venue: "hospital",
        country: "IN",
        campaign,
        region: "odisha",
      });
      expect(report.total).toBe(1);
      expect(report.variantResponses).toBe(1);
      expect(report.responses).toHaveLength(1);
      expect(report.responses[0].answers.region).toBe("Odisha");
      expect(report.variants).toEqual([{ product: "masala-chai", votes: 1 }]);
      if (form === "vending-customers") {
        expect(report.products).toEqual([
          { product: "coffee-tea", votes: 1, first_choices: 1 },
        ]);
        expect(report.prices[0].drink_median_minor).toBe(2000);
      }
    }
  } finally {
    await db.execute(
      sql`delete from vending_customers.responses where campaign=${campaign}`,
    );
    await db.execute(
      sql`delete from vending_business.responses where campaign=${campaign}`,
    );
    await db.execute(
      sql`delete from questionnaires_api.rate_limits where bucket= ${campaign}`,
    );
  }
});
