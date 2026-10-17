import { z } from "zod";
import { VARIANTS, VARIANT_IDS, VARIANT_LABELS } from "./catalog";
export { VARIANTS, suggestedVariants, marketPreset } from "./catalog";

export const FORM_IDS = ["vending-customers", "vending-business"] as const;
export type FormId = (typeof FORM_IDS)[number];
export type Field = {
  key: string;
  label: string;
  type: "text" | "email" | "textarea" | "select" | "multi" | "number";
  section: string;
  options?: readonly string[];
  required?: boolean;
  max?: number;
  hint?: string;
  venues?: readonly string[];
};
export const PRODUCTS = [
  "water",
  "sparkling-water",
  "electrolyte-drinks",
  "protein-shakes",
  "fresh-juice",
  "low-sugar-drinks",
  "coffee-tea",
  "energy-drinks",
  "protein-bars",
  "nuts-seeds",
  "fruit",
  "yoghurt",
  "sandwiches-wraps",
  "savoury-snacks",
  "chocolate",
  "confectionery",
] as const;
export type Product = (typeof PRODUCTS)[number];
export const VENUES = [
  "gym",
  "shopping-centre",
  "office",
  "university",
  "hospital",
  "transport-hub",
  "residential",
  "other",
] as const;
export const CURRENCIES = [
  "AUD",
  "NZD",
  "INR",
  "USD",
  "GBP",
  "EUR",
  "SGD",
  "AED",
  "BRL",
  "CAD",
  "IDR",
  "JPY",
  "MYR",
  "PHP",
  "SAR",
  "THB",
] as const;
export const label = (value: string) =>
  VARIANT_LABELS.get(value) ??
  (
    {
      "protein-bars": "Snack / protein bars",
      "coffee-tea": "Coffee and tea",
      "local-qr": "Local QR payment",
    } as Record<string, string>
  )[value] ??
  value
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
const location: Field[] = [
  {
    key: "venueType",
    label: "What type of location is this?",
    type: "select",
    section: "Location",
    options: VENUES,
    required: true,
  },
  {
    key: "country",
    label: "Country",
    type: "text",
    section: "Location",
    required: true,
    hint: "Choose the country of the venue. Currency is matched automatically; you can change it.",
  },
  {
    key: "addressLine1",
    label: "Venue street address (optional)",
    type: "text",
    section: "Location",
    hint: "Use a public venue address, not your home address. You can enter or correct all address fields manually.",
  },
  {
    key: "region",
    label: "State / region (optional)",
    type: "text",
    section: "Location",
  },
  {
    key: "city",
    label: "City / suburb",
    type: "text",
    section: "Location",
    required: true,
  },
  {
    key: "postcode",
    label: "Postcode / ZIP",
    type: "text",
    section: "Location",
  },
  {
    key: "venueName",
    label: "Venue or branch name (optional)",
    type: "text",
    section: "Location",
  },
  {
    key: "campaign",
    label: "Survey location / campaign code (optional)",
    type: "text",
    section: "Location",
    hint: "Use the code supplied with your survey link, if any.",
  },
  {
    key: "currency",
    label: "Currency for any prices you provide",
    type: "select",
    section: "Location",
    options: CURRENCIES,
    required: true,
    hint: "Matched to country. Changing currency does not convert any amounts you already entered; please recheck price answers.",
  },
];
const select = (
  key: string,
  text: string,
  section: string,
  options: readonly string[],
  required = false,
): Field => ({ key, label: text, section, type: "select", options, required });
const text = (
  key: string,
  text: string,
  section: string,
  hint?: string,
): Field => ({ key, label: text, section, type: "textarea", hint });
const multi = (
  key: string,
  text: string,
  section: string,
  options: readonly string[],
  required = false,
  max = 10,
): Field => ({
  key,
  label: text,
  section,
  type: "multi",
  options,
  required,
  max,
});
const amount = (
  key: string,
  text: string,
  section: string,
  max = 10000,
): Field => ({
  key,
  label: text,
  section,
  type: "number",
  max,
  hint:
    key === "revenueSharePercent"
      ? "Optional percentage from 0 to 100; this is not a currency amount."
      : "Optional estimate in the currency selected above. Leave blank if unknown.",
});
export const customerFields: Field[] = [
  ...location,
  select(
    "visitFrequency",
    "How often do you visit this type of location?",
    "Habits",
    ["daily", "several-times-weekly", "weekly", "monthly", "rarely"],
    true,
  ),
  multi("visitTime", "When do you usually visit?", "Habits", [
    "early-morning",
    "morning",
    "lunchtime",
    "afternoon",
    "evening",
    "late-night",
  ]),
  select(
    "purchaseFrequency",
    "If suitable products were available at an acceptable price, how often would you buy?",
    "Habits",
    [
      "daily",
      "several-times-weekly",
      "weekly",
      "monthly",
      "rarely",
      "never",
      "unsure",
    ],
    true,
  ),
  multi(
    "products",
    "Which products would you consider buying? Choose up to five, or leave empty for none.",
    "Product choices",
    PRODUCTS,
    false,
    5,
  ),
  {
    key: "productVariants",
    label: "Which specific items would you choose? (optional)",
    type: "multi",
    section: "Product choices",
    options: VARIANT_IDS,
    max: 12,
    hint: "Choose up to 12 details within your selected categories. Suggestions follow the venue country and state; you can explore all cuisines. These are preferences, not a promise of availability.",
  },
  {
    key: "flavourPreferences",
    label: "Which tastes would you prefer? (optional)",
    type: "multi",
    section: "Product choices",
    options: [
      "mild",
      "medium-spice",
      "spicy",
      "sweet",
      "less-sweet",
      "savoury",
      "unsalted",
      "none",
    ],
    hint: "Select your own preferences; location does not determine taste. None means no specific preference.",
  },
  {
    key: "drinkTemperatures",
    label: "Which drink temperatures would suit you? (optional)",
    type: "multi",
    section: "Product choices",
    options: ["chilled", "room-temperature", "hot", "none"],
  },
  select(
    "topProduct",
    "Which would be your first choice?",
    "Product choices",
    [...PRODUCTS, "none"],
    true,
  ),
  text(
    "preferredBrands",
    "Any specific brands, flavours or pack sizes?",
    "Product choices",
  ),
  multi(
    "dietaryPreferences",
    "Which product options should the machine offer?",
    "Product choices",
    [
      "high-protein",
      "low-sugar",
      "vegan",
      "vegetarian",
      "gluten-free",
      "dairy-free",
      "halal",
      "nut-free",
      "none",
      "other",
    ],
  ),
  amount(
    "maxSnackPrice",
    "Maximum you would pay for one snack / bar",
    "Price and experience",
  ),
  amount(
    "maxDrinkPrice",
    "Maximum you would pay for one drink",
    "Price and experience",
  ),
  multi(
    "paymentMethods",
    "Which payment methods would you use?",
    "Price and experience",
    ["card", "mobile-wallet", "cash", "local-qr", "other"],
    true,
  ),
  multi(
    "purchaseBarriers",
    "What could stop you buying?",
    "Price and experience",
    [
      "price",
      "not-needed",
      "bring-my-own",
      "better-nearby-options",
      "limited-choice",
      "ingredients-unclear",
      "freshness",
      "sold-out",
      "payment-failure",
      "refund-concerns",
      "none",
      "other",
    ],
  ),
  text(
    "bestLocation",
    "Where in the venue would a machine be most useful?",
    "Price and experience",
    "Do not include access codes or private security details.",
  ),
  text(
    "comments",
    "Anything missing, or anything you would avoid?",
    "Price and experience",
  ),
];
export const businessFields: Field[] = [
  ...location,
  {
    key: "businessName",
    label: "Business / organisation name",
    section: "Location",
    type: "text",
    required: true,
  },
  select(
    "authority",
    "What is your role in approving a vending installation?",
    "Location",
    [
      "decision-maker",
      "site-manager",
      "property-manager",
      "tenant-needs-landlord-approval",
      "researching",
      "other",
    ],
    true,
  ),
  {
    key: "requestedProducts",
    label: "Which product categories would suit your venue? (optional)",
    type: "multi",
    section: "Demand",
    options: PRODUCTS,
    max: 5,
  },
  {
    key: "productVariants",
    label: "Which specific items would suit your venue? (optional)",
    type: "multi",
    section: "Demand",
    options: VARIANT_IDS,
    max: 12,
    hint: "Choose up to 12 details. Country and state suggestions are editable; all cuisines can be explored. Stocking requires supplier, food-safety and site approval.",
  },
  select(
    "footfall",
    "Estimated visits past the proposed position per day",
    "Demand",
    ["under-50", "50-199", "200-499", "500-999", "1000-plus", "unknown"],
    true,
  ),
  select("footfallBasis", "What is this estimate based on?", "Demand", [
    "measured-counter",
    "membership-or-sales-data",
    "staff-estimate",
    "unknown",
  ]),
  text(
    "peakTimes",
    "Peak hours, weekdays / weekends, and seasonal changes",
    "Demand",
  ),
  text(
    "audience",
    "Who uses the site: members, staff, shoppers, students, visitors?",
    "Demand",
  ),
  text(
    "competition",
    "Existing vending, café, shops, exclusivity agreements or restrictions",
    "Demand",
  ),
  text(
    "placement",
    "Proposed position, visibility and distance from competing food options",
    "Site and utilities",
  ),
  text(
    "space",
    "Available footprint, height clearance, floor loading and indoor / outdoor conditions",
    "Site and utilities",
  ),
  select(
    "power",
    "Is suitable continuous power available nearby?",
    "Site and utilities",
    [
      "yes-dedicated-outlet",
      "yes-shared-outlet",
      "installation-needed",
      "no",
      "unknown",
    ],
    true,
  ),
  text(
    "powerDetails",
    "Outlet voltage / rating, distance, electrical approval and outage history (if known)",
    "Site and utilities",
  ),
  select(
    "electricityPayment",
    "How would electricity be charged?",
    "Site and utilities",
    [
      "included-in-rent",
      "metered-at-cost",
      "fixed-fee",
      "operator-arranges",
      "negotiable",
      "unknown",
    ],
  ),
  amount(
    "electricityMonthly",
    "Estimated monthly electricity charge",
    "Site and utilities",
    100000,
  ),
  select(
    "internet",
    "Available connectivity",
    "Site and utilities",
    ["venue-wifi", "ethernet", "cellular-signal", "none", "unknown"],
    true,
  ),
  text(
    "internetDetails",
    "Guest network restrictions, cellular coverage and permitted connectivity",
    "Site and utilities",
    "Do not provide Wi-Fi passwords, credentials or network diagrams.",
  ),
  select(
    "coldChain",
    "Could chilled products be supported with continuous power and safe servicing?",
    "Site and utilities",
    ["yes", "ambient-products-only", "needs-assessment", "unknown"],
  ),
  text(
    "installationAccess",
    "Delivery route, loading bay, stairs / lift, doorway clearance, anchoring and permits",
    "Site and utilities",
  ),
  {
    key: "hospitalSaleArea",
    label: "Where would the hospital machine be placed?",
    type: "select",
    section: "Site and utilities",
    venues: ["hospital"],
    options: [
      "public-lobby",
      "staff-area",
      "outpatient-common-area",
      "clinically-controlled-area",
      "unknown",
    ],
  },
  {
    key: "hospitalAudiences",
    label: "Who is the hospital retail provision intended for?",
    type: "multi",
    section: "Site and utilities",
    venues: ["hospital"],
    options: [
      "staff",
      "visitors-carers",
      "general-public",
      "separate-clinical-diet-service",
      "unknown",
    ],
    hint: "Describe the service, not any individual patient or condition. Clinical patient food requires a separate approval pathway.",
  },
  {
    key: "hospitalApprovals",
    label: "Which hospital teams have approved the proposal?",
    type: "multi",
    section: "Site and utilities",
    venues: ["hospital"],
    options: [
      "food-service-dietitian",
      "infection-control",
      "facilities",
      "procurement",
      "none",
    ],
    hint: "None means approvals have not yet been obtained. A questionnaire response is not approval to install or sell.",
  },
  {
    key: "hospitalRestrictions",
    label:
      "Which items require restriction or review under the hospital policy?",
    type: "multi",
    section: "Site and utilities",
    venues: ["hospital"],
    options: [
      "high-sugar-drinks",
      "high-salt-snacks",
      "high-saturated-fat-foods",
      "energy-drinks-caffeine",
      "nuts-allergens",
      "fresh-chilled-foods",
      "hot-drinks",
      "glass-containers",
      "other",
      "unknown",
    ],
  },
  {
    key: "hospitalPolicy",
    label:
      "Policy reference, required nutrition criteria or responsible department (optional)",
    type: "textarea",
    section: "Site and utilities",
    venues: ["hospital"],
    hint: "Do not include patient information, internal access credentials or private security details.",
  },
  select(
    "commercialModel",
    "Preferred commercial arrangement",
    "Commercial terms",
    [
      "fixed-rent",
      "revenue-share",
      "hybrid",
      "free-amenity",
      "negotiable",
      "not-interested",
    ],
    true,
  ),
  amount(
    "rentMonthly",
    "Expected monthly rent / site fee",
    "Commercial terms",
    1000000,
  ),
  amount(
    "revenueSharePercent",
    "Expected revenue share (%)",
    "Commercial terms",
    100,
  ),
  text(
    "commercialDetails",
    "Deposit, GST / tax, minimum guarantees, exclusivity, contract term and exit notice",
    "Commercial terms",
  ),
  select("startTime", "When could a pilot begin?", "Commercial terms", [
    "now",
    "within-1-month",
    "1-3-months",
    "3-6-months",
    "later",
    "undecided",
  ]),
  text(
    "approvals",
    "Landlord / centre approvals, insurance, food registration and site rules to confirm",
    "Commercial terms",
  ),
  multi("security", "Which security measures are available?", "Operations", [
    "cctv",
    "staff-presence",
    "restricted-access",
    "secure-anchoring-permitted",
    "none",
    "unknown",
  ]),
  text(
    "operatingHours",
    "Customer access hours and any closures",
    "Operations",
  ),
  text(
    "serviceAccess",
    "Restocking / maintenance access windows, keys process and parking",
    "Operations",
    "Describe the process only; do not include keys, alarm codes or access credentials.",
  ),
  text(
    "responsibilities",
    "Who can report faults? Expectations for cleaning, litter, recycling and pest control",
    "Operations",
  ),
  text(
    "accessibility",
    "Accessible approach, circulation space, reach / payment access and emergency exits",
    "Operations",
  ),
  text(
    "maintenance",
    "Desired fault response time, refund handling, outages and local service support",
    "Operations",
  ),
  text(
    "productRestrictions",
    "Product restrictions: nutrition policy, allergens, glass, caffeine, chilled / fresh food",
    "Operations",
  ),
  {
    key: "contactName",
    label: "Contact name",
    section: "Contact",
    type: "text",
    hint: "Required if you are interested in discussing a pilot; optional if declining.",
  },
  {
    key: "contactEmail",
    label: "Business contact email",
    section: "Contact",
    type: "email",
    hint: "Required if you are interested in discussing a pilot; optional if declining.",
  },
  {
    key: "contactPhone",
    label: "Business phone (optional)",
    section: "Contact",
    type: "text",
  },
  text(
    "comments",
    "Anything else we should assess before proposing a pilot?",
    "Contact",
  ),
];
export const forms = {
  "vending-customers": {
    title: "Your next convenient bite",
    subtitle:
      "Help shape vending choices for gyms, shopping centres and everyday spaces.",
    audience: "Customer survey · about 4 minutes",
    fields: customerFields,
  },
  "vending-business": {
    title: "A better amenity for your space",
    subtitle:
      "Explore whether a vending installation could work at your venue.",
    audience: "Business survey · about 8 minutes",
    fields: businessFields,
  },
} as const;
export function submissionSchema(form: FormId) {
  const shape: Record<string, z.ZodType> = {
    version: z.literal(1),
    consent: z.literal(true),
    website: z.literal(""),
  };
  for (const f of forms[form].fields) {
    if (f.type === "multi") {
      const choices = z
        .array(z.enum(f.options as [string, ...string[]]))
        .max(f.max ?? 10)
        .refine((v) => new Set(v).size === v.length, "Choose each option once")
        .refine(
          (v) => !v.includes("none") || v.length === 1,
          "None cannot be combined with other choices",
        );
      shape[f.key] = [
        "productVariants",
        "requestedProducts",
        "flavourPreferences",
        "drinkTemperatures",
        "hospitalAudiences",
        "hospitalApprovals",
        "hospitalRestrictions",
      ].includes(f.key)
        ? choices.optional()
        : choices.default([]);
    } else if (f.type === "number")
      shape[f.key] = z
        .number()
        .finite()
        .min(0)
        .max(f.max ?? 10000)
        .refine(
          (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6,
          "Use at most two decimal places",
        )
        .optional();
    else if (f.type === "select") {
      const choice = z.enum(f.options as [string, ...string[]]);
      shape[f.key] = f.required
        ? choice
        : z.union([choice, z.literal("")]).optional();
    } else {
      let field = z
        .string()
        .trim()
        .max(f.type === "textarea" ? 1500 : 200);
      if (f.required) field = field.min(1, "This answer is required");
      if (f.type === "email") field = field.email("Enter a valid email");
      if (f.key === "country")
        field = field.regex(
          /^[A-Z]{2}$/,
          "Use a two-letter uppercase country code",
        );
      shape[f.key] = f.required
        ? field
        : z.union([field, z.literal("")]).optional();
    }
  }
  return z.strictObject(shape).superRefine((v, ctx) => {
    if (form === "vending-business" && v.venueType !== "hospital") {
      for (const field of businessFields.filter((f) =>
        f.venues?.includes("hospital"),
      )) {
        const value = v[field.key];
        if (Array.isArray(value) ? value.length : !!value)
          ctx.addIssue({
            code: "custom",
            path: [field.key],
            message: "Hospital-specific answers require a hospital venue",
          });
      }
    }
    const families = (v[
      form === "vending-customers" ? "products" : "requestedProducts"
    ] ?? []) as string[];
    for (const variant of (v.productVariants ?? []) as string[]) {
      const item = VARIANTS.find((i) => i.id === variant);
      if (item && !families.includes(item.family))
        ctx.addIssue({
          code: "custom",
          path: ["productVariants"],
          message:
            "Choose the matching product category before selecting its details",
        });
    }
    for (const f of forms[form].fields.filter(
      (f) => f.type === "number" && f.key !== "revenueSharePercent",
    )) {
      const amount = v[f.key];
      if (
        typeof amount === "number" &&
        Math.abs(
          amount * 10 ** currencyDigits(String(v.currency)) -
            Math.round(amount * 10 ** currencyDigits(String(v.currency))),
        ) > 1e-6
      )
        ctx.addIssue({
          code: "custom",
          path: [f.key],
          message:
            "Use the number of decimal places supported by this currency",
        });
    }
    if (form === "vending-business" && v.commercialModel !== "not-interested") {
      for (const key of ["contactName", "contactEmail"])
        if (!v[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Please provide a contact for venue follow-up",
          });
    }
    if (form === "vending-customers") {
      const products = v.products as string[];
      if (v.topProduct !== "none" && !products.includes(v.topProduct as string))
        ctx.addIssue({
          code: "custom",
          path: ["topProduct"],
          message: "Your first choice must be one of your selected products",
        });
      if (v.topProduct === "none" && products.length)
        ctx.addIssue({
          code: "custom",
          path: ["topProduct"],
          message: "Choose a first choice from your selected products",
        });
      if (!(v.paymentMethods as string[]).length)
        ctx.addIssue({
          code: "custom",
          path: ["paymentMethods"],
          message: "Choose a payment method",
        });
    }
  });
}
export const validateSubmission = (form: FormId, value: unknown) =>
  submissionSchema(form).safeParse(value);
export const isFormId = (value: string): value is FormId =>
  (FORM_IDS as readonly string[]).includes(value);
export const currencyDigits = (currency: string): number =>
  new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
export const minorUnits = (value: unknown, currency = "AUD"): number | null =>
  typeof value === "number"
    ? Math.round(value * 10 ** currencyDigits(currency))
    : null;
export const formatMinorPrice = (value: number, currency: string): string =>
  (value / 10 ** currencyDigits(currency)).toFixed(currencyDigits(currency));
export function demandDecision(votes: number, total: number): string {
  if (total < 30) return "Collect more responses";
  const share = votes / total;
  return share >= 0.3
    ? "Consider a small pilot"
    : share >= 0.1
      ? "Test a limited range"
      : "Deprioritise for this audience";
}
export function isResearchPath(path: string): boolean {
  return (
    path === "/vending-customers" ||
    path === "/vending-business" ||
    path === "/questionnaire" ||
    path.startsWith("/questionnaire/")
  );
}

export const isPublicQuestionnairePath = (path: string): boolean =>
  /^\/(vending-customers|vending-business|questionnaire|questionnaire\/privacy|api\/questionnaires\/(vending-customers|vending-business|location))\/?$/.test(
    path,
  );
