import Link from "next/link";

import { createFoodAction } from "../actions";
import { FoodForm } from "../food-form";

export default function NewKoraFoodPage() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <Link
          href="/admin/apps/kora/foods"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Food index
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-foreground">New food</h1>
        <p className="text-sm text-muted-foreground">
          Hand-authored entries default to the <code>curated</code> provenance. Macros are per 100g,
          not per serving.
        </p>
      </div>

      <FoodForm action={createFoodAction} />
    </div>
  );
}
