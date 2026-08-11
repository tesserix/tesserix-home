import {
  ShoppingBag,
  Users,
  Building2,
  KeyRound,
  Wrench,
  MessageSquare,
  Palette,
  CreditCard,
  Package,
  BarChart,
  Shield,
  ChefHat,
  Utensils,
  Truck,
  Hospital,
  Stethoscope,
  Calendar,
  FileText,
  Pill,
  UserCheck,
  Salad,
  Camera,
  Mic,
  ScanLine,
  Pencil,
  ShieldCheck,
} from "lucide-react";

interface ProductMediaImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  orientation: "landscape" | "portrait";
}

/**
 * The five industries the current portfolio covers, one per product. This is
 * the single source of truth for the "one industry at a time" marketing
 * copy repeated on the hero, footer and /about — those sites derive their
 * industry list from `industryNames` below instead of holding their own copy.
 */
export type Industry = "commerce" | "food" | "rentals" | "healthcare" | "nutrition";

export const products: Record<
  string,
  {
    title: string;
    tagline: string;
    description: string;
    longDescription: string;
    icon: React.ComponentType<{ className?: string }>;
    status: "available" | "coming-soon";
    industry: Industry;
    /**
     * Short bullet points used everywhere a product is summarized rather
     * than detailed: the /products index rows and the homepage card stack
     * (`products-grid.tsx`). Both used to keep their own copies of this list
     * and drifted (that's how Mark8ly ended up with three descriptions) —
     * they now read this field instead of restating it.
     */
    highlights: string[];
    /**
     * Honest target for a coming-soon product's launch, shown on the
     * homepage's "In development" card (`products-grid.tsx`). Omit rather
     * than guess a date for a product with no committed timeline.
     */
    eta?: string;
    features: Array<{
      icon: React.ComponentType<{ className?: string }>;
      title: string;
      description: string;
    }>;
    benefits: string[];
    // Pricing lives on each product's own site, not here — see product-content.tsx.
    website?: string;
    /**
     * The detail page's primary CTA for `available` products only — the
     * label must match where the link actually goes, so it's authored per
     * product rather than a single generic "Start free trial" that isn't
     * true for every product (e.g. Fe3dr has no trial). Links to the
     * product's own site (`website`), not `/contact`.
     */
    ctaLabel?: string;
    /** Honest one-line subtext for the bottom CTA band; omit if there's nothing true to add. */
    ctaSubtext?: string;
    /**
     * The real trial/pricing offer, stated exactly as the product's own
     * site states it. Omit entirely for products with no trial (e.g. Fe3dr)
     * rather than falling back to generic trial language.
     */
    trialLine?: string;
    /**
     * JSON-LD `operatingSystem` for the SoftwareApplication schema. Defaults
     * to "Web" when omitted — set explicitly for products that are actually
     * mobile-only (Kora, Fe3dr's app), since asserting "Web" for those is a
     * verifiable-false claim to a crawler.
     */
    operatingSystem?: string;
    /**
     * App store presence, keyed by platform. A listing with `url: ""` is a
     * real platform we're on that has no live link yet (e.g. iOS apps under
     * App Store review) — `AppStoreBadges` renders it as a coming-soon plate
     * rather than a dead link. Omit a platform entirely if there is no app.
     */
    listings?: Partial<
      Record<"ios" | "android", { url: string; artworkSrc: string }>
    >;
    /**
     * The Fe3dr vendor (home-cook) Android app is a second audience beyond
     * the customer app in `listings`. Only Fe3dr has one today, so it's kept
     * as a separate optional field rather than widening the platform union.
     */
    vendorListing?: { url: string; artworkSrc: string };
    /**
     * Real product imagery for the detail page. Only populated for products
     * that have actually shipped (`status: "available"`) — a mockup for
     * unreleased software erodes trust on a due-diligence read, so
     * coming-soon products must leave this undefined rather than get a
     * placeholder.
     */
    media?: {
      /** A capture of the live marketing site or storefront, landscape. */
      site?: ProductMediaImage;
      /** Portrait phone screenshots, shown as a row of two or three. */
      screenshots?: ProductMediaImage[];
    };
  }
> = {
  mark8ly: {
    title: "Mark8ly",
    tagline: "Quiet commerce for people who make things",
    description:
      "An editorial commerce platform for independent merchants. Set up in an afternoon, keep your margins.",
    website: "https://mark8ly.com",
    longDescription:
      "Mark8ly is a quiet, considered commerce platform for people who actually make things. Set up your store in an afternoon, keep every sale, and sell on a storefront that doesn't look like everyone else's. Real merchants worked on the design. Real engineers built the infrastructure. The result is a tool that does fewer things, but does them properly.",
    icon: ShoppingBag,
    status: "available",
    industry: "commerce",
    ctaLabel: "Start free trial",
    ctaSubtext: "Free for ninety days. No card required.",
    trialLine: "Free for ninety days. No card required.",
    highlights: [
      "0% transaction fees, ever",
      "Custom domains from day one",
      "Considered theme system",
      "Unlimited products & orders",
      "Cards, UPI, and wallets",
      "Real human support",
    ],
    features: [
      {
        icon: Palette,
        title: "A storefront worth opening",
        description:
          "A theme that feels considered, out of the box. Quiet typography, generous whitespace, real attention to product detail pages.",
      },
      {
        icon: CreditCard,
        title: "Checkout that works everywhere",
        description:
          "Cards, UPI, wallets, and local methods, all behind a single checkout. No upcharges from us — standard processor fees only.",
      },
      {
        icon: Package,
        title: "Unlimited products and orders",
        description:
          "Every plan includes unlimited products and orders. Plans differ by number of stores and images per product, not a product cap.",
      },
      {
        icon: BarChart,
        title: "Admin you don't have to learn",
        description:
          "Products, orders, customers, inventory. Each screen does one thing, clearly. No dashboards full of metrics that don't matter.",
      },
      {
        icon: Shield,
        title: "Yours, fully",
        description:
          "Use your own domain, export your data anytime, leave whenever you want. The store is yours — we just keep it running.",
      },
      {
        icon: Users,
        title: "Real humans answer",
        description:
          "If you get stuck, real humans answer real messages. No chatbots, no first-tier triage queue.",
      },
    ],
    benefits: [
      "Free for ninety days, no card required",
      "0% transaction fees from Mark8ly, ever",
      "Use your own domain from day one",
      "Export your data and leave anytime",
      "White-label mobile app available as a paid add-on",
      "Three plans, one price page — no bait and switch",
    ],
    listings: {
      ios: { url: "", artworkSrc: "/badges/app-store-badge.svg" },
      android: {
        url: "https://play.google.com/store/apps/details?id=com.mark8ly.admin",
        artworkSrc: "/badges/google-play-badge.png",
      },
    },
    media: {
      site: {
        src: "/screens/mark8ly-storefront.jpg",
        alt: "The Mark8ly marketing homepage, headlined “A storefront worth opening,” with a live demo of a working store and checkout below the fold",
        width: 1568,
        height: 682,
        orientation: "landscape",
      },
    },
  },
  fe3dr: {
    title: "Fe3dr",
    tagline: "Ghar ka khana, delivered.",
    description:
      "Real home-cooked food from verified kitchens near you. Cooked to order, collect it or have it delivered.",
    website: "https://fe3dr.com",
    longDescription:
      "Fe3dr connects verified home cooks with people who want a real home-cooked meal. Every meal is cooked to order — nothing sits pre-made or reheated — and you choose to collect it yourself or have it delivered. Fe3dr is currently live in Pune.",
    icon: ChefHat,
    status: "available",
    industry: "food",
    operatingSystem: "iOS, Android",
    // No trialLine: Fe3dr is a marketplace where customers buy meals, not a
    // subscription product — there is no trial to offer.
    ctaLabel: "Order on Fe3dr",
    ctaSubtext: "Browse home-cooked meals from verified kitchens near you.",
    highlights: [
      "Verified home cooks",
      "Cooked to order",
      "Collection or delivery",
      "Live in Pune",
    ],
    features: [
      {
        icon: UserCheck,
        title: "Verified home cooks",
        description:
          "Every cook is verified before their menu goes live, so an order comes from a real home kitchen you can trust.",
      },
      {
        icon: Utensils,
        title: "Cooked to order",
        description:
          "Meals are cooked fresh once you order — not held in inventory or reheated ahead of time.",
      },
      {
        icon: Truck,
        title: "Collection or delivery",
        description:
          "Pick up your order yourself or have it delivered — whichever suits you on the day.",
      },
      {
        icon: ChefHat,
        title: "Home kitchens, not restaurants",
        description:
          "Every meal comes from a real home kitchen, cooked the way home food actually tastes.",
      },
    ],
    benefits: [
      "Verified home cooks, not commercial kitchens",
      "Cooked to order, never pre-made",
      "Collect it yourself or have it delivered",
      "Currently live in Pune",
    ],
    listings: {
      ios: { url: "", artworkSrc: "/badges/app-store-badge.svg" },
      android: {
        url: "https://play.google.com/store/apps/details?id=com.tesserix.homechef.customer",
        artworkSrc: "/badges/google-play-badge.png",
      },
    },
    vendorListing: {
      url: "https://play.google.com/store/apps/details?id=com.tesserix.homechef.vendor",
      artworkSrc: "/badges/google-play-badge.png",
    },
    media: {
      site: {
        src: "/screens/fe3dr-web.jpg",
        alt: "The Fe3dr homepage, headlined “Ghar ka khana, delivered,” showing home-cooked dishes on offer and a live delivery tracker",
        width: 1568,
        height: 682,
        orientation: "landscape",
      },
      screenshots: [
        {
          src: "/screens/fe3dr-app-browse.png",
          alt: "The Fe3dr app home screen, showing nearby home kitchens by cuisine with an active order tracked at the bottom",
          width: 1080,
          height: 1920,
          orientation: "portrait",
        },
        {
          src: "/screens/fe3dr-app-chef-menu.png",
          alt: "A home kitchen's menu inside the Fe3dr app, showing dish photos, dietary tags and prices",
          width: 1080,
          height: 1920,
          orientation: "portrait",
        },
        {
          src: "/screens/fe3dr-app-orders.png",
          alt: "The Fe3dr app order history screen, listing past and pending orders with their status and price",
          width: 1080,
          height: 1920,
          orientation: "portrait",
        },
      ],
    },
  },
  dwellm8: {
    title: "Dwellm8",
    tagline: "Rent, managed like a record",
    description:
      "India-first rental management — owners, managers and tenants on one record, from listing to move-out.",
    // No `website`: dwellm8.com does not resolve. Dwellm8 is coming-soon, so
    // every surface that renders a product website link already gates on
    // `website` being present / status being "available" and simply omits
    // the link here.
    longDescription:
      "Dwellm8 runs the whole tenancy on one record: listings and enquiries, agreements and rent, maintenance and the gate. Owners see what their property earns, managing firms run delegated portfolios against a ledger rather than a spreadsheet, and tenants get an app where the rent, the receipts and the repair requests are all on the record. Money is integer paise on an append-only ledger — nothing is a stored balance, and nothing is quietly deleted.",
    icon: Building2,
    status: "coming-soon",
    industry: "rentals",
    eta: "2026",
    highlights: [
      "Tenancy agreements & rent schedules",
      "UPI rent, instant receipts, zero platform fees",
      "Maintenance & cost-sharing engine",
      "Delegated portfolio management",
      "Listings, enquiries & applications",
      "Six mobile apps, one platform",
    ],
    features: [
      {
        icon: KeyRound,
        title: "The tenancy on one record",
        description:
          "Agreements, rent schedules, deposits, notice and move-out — effective-dated history, never edited in place.",
      },
      {
        icon: CreditCard,
        title: "Rent by UPI, receipts instantly",
        description:
          "Collections land on an append-only ledger and the receipt issues the moment money confirms. No platform fee added to rent.",
      },
      {
        icon: Wrench,
        title: "Maintenance with a liability answer",
        description:
          "Tenants raise a request in thirty seconds; the cost-sharing engine says who pays before any work is approved.",
      },
      {
        icon: MessageSquare,
        title: "Everything on the record",
        description:
          "The tenancy conversation, gate passes and notices live in the apps — not in somebody's chat history.",
      },
      {
        icon: Users,
        title: "Six apps, one platform",
        description:
          "Own, Ops, Live, Find, Pro and Admin — owners, managing firms, tenants and seekers each get their own surface.",
      },
      {
        icon: Shield,
        title: "Isolation the database enforces",
        description:
          "Row-level security scopes every query to one organisation, and a tenant to their own lease — not a WHERE clause somebody remembered.",
      },
    ],
    benefits: [
      "Owners see income, dues and documents per property",
      "Managing firms run delegated portfolios under scoped mandates",
      "Tenants pay rent by UPI with zero platform fees",
      "Deposits, lock-ins and notice handled per the agreement",
      "Discovery to move-in: listings, enquiries, applications",
      "Mobile apps for every side of the tenancy",
    ],
  },
  medicare: {
    title: "MediCare",
    tagline: "Hospital management without the bloat",
    description:
      "End-to-end clinic and hospital operations — patient records, scheduling, billing, pharmacy, and lab, without enterprise software's bloat.",
    longDescription:
      "MediCare handles hospital operations end to end: patient registration and electronic health records, appointment scheduling, billing, and pharmacy inventory. It's built for clinics and hospitals that outgrew spreadsheets but never wanted enterprise software's bloat.",
    icon: Hospital,
    status: "coming-soon",
    industry: "healthcare",
    eta: "2026",
    highlights: [
      "Electronic health records",
      "Appointment scheduling",
      "Billing & invoicing",
      "Pharmacy & inventory",
      "Staff management",
      "HIPAA-aligned",
    ],
    features: [
      {
        icon: FileText,
        title: "Electronic health records",
        description:
          "Secure, centralized patient records with medical history, prescriptions, lab results, and imaging.",
      },
      {
        icon: Calendar,
        title: "Appointment scheduling",
        description:
          "Smart scheduling system with doctor availability, patient reminders, and waitlist management.",
      },
      {
        icon: CreditCard,
        title: "Billing & invoicing",
        description:
          "Automated billing, insurance claim processing, and payment tracking with detailed financial reports.",
      },
      {
        icon: Pill,
        title: "Pharmacy & inventory",
        description:
          "Complete pharmacy management with drug inventory, expiry tracking, and prescription fulfillment.",
      },
      {
        icon: Users,
        title: "Staff management",
        description:
          "Employee scheduling, attendance tracking, payroll integration, and performance management.",
      },
      {
        icon: Stethoscope,
        title: "Lab & diagnostics",
        description:
          "Lab test ordering, result tracking, and integration with diagnostic equipment for seamless workflows.",
      },
    ],
    benefits: [
      "Improve patient care coordination",
      "Real-time bed and resource management",
      "Multi-location support",
      "HIPAA-aligned data security",
      "Integration with medical devices",
    ],
  },
  kora: {
    title: "Kora",
    tagline: "The easiest nutrition tracking experience, built with AI",
    description:
      "AI-powered nutrition tracking for iOS and Android — log meals by photo, chat, or voice instead of manual data entry.",
    longDescription:
      "Kora is an AI-powered nutrition tracking app for iOS and Android. It isn't meant to be another calorie counter — the goal is the easiest nutrition tracking experience ever built, one that feels conversational rather than like data entry. Log a meal with a food photo, a natural-language message, or your voice. Nutrition data is sourced from the USDA, OpenFoodFacts, and Australian food databases, and Kora is built to never hallucinate a nutrition value.",
    icon: Salad,
    status: "coming-soon",
    industry: "nutrition",
    operatingSystem: "iOS, Android",
    eta: "2026",
    highlights: [
      "Photo, chat, voice & barcode logging",
      "Manual editing",
      "USDA, OpenFoodFacts & AU databases",
      "Built to never hallucinate a value",
      "iOS and Android",
    ],
    features: [
      {
        icon: Camera,
        title: "AI photo logging",
        description:
          "Photograph a meal and Kora identifies the foods, ingredients, and portion sizes.",
      },
      {
        icon: MessageSquare,
        title: "Chat logging",
        description:
          "Describe what you ate in plain language and Kora understands and logs it.",
      },
      {
        icon: Mic,
        title: "Voice logging",
        description:
          "Speak a meal out loud and it converts straight to a food log.",
      },
      {
        icon: ScanLine,
        title: "Barcode scanning",
        description:
          "Scan a barcode for an instant nutrition lookup on packaged food.",
      },
      {
        icon: Pencil,
        title: "Manual editing",
        description:
          "Adjust any logged meal by hand whenever you want to fine-tune the details yourself.",
      },
      {
        icon: ShieldCheck,
        title: "Verified nutrition data",
        description:
          "Nutrition figures are sourced from the USDA, OpenFoodFacts, and Australian food databases — built to never hallucinate a value.",
      },
    ],
    benefits: [
      "Log meals by photo, chat, voice, or barcode",
      "Nutrition data sourced from USDA, OpenFoodFacts, and Australian databases",
      "Built to never hallucinate a nutrition value",
      "Conversational logging, not data entry",
      "iOS and Android",
    ],
  },
};

/**
 * Every product slug. Derived from `products` so the two can never drift —
 * the waitlist API validates signups against this, and the launch-announce job
 * walks it to find products that have gone live.
 */
export const productSlugs: string[] = Object.keys(products);

/**
 * Slugs whose status has flipped to "available", i.e. products that have
 * actually launched. Flipping a product's status here and deploying is what
 * triggers its waitlist announcement — there is no separate switch to remember.
 */
export function launchedProductSlugs(): string[] {
  return Object.entries(products)
    .filter(([, p]) => p.status === "available")
    .map(([slug]) => slug);
}

/** Display title for a slug, for email subject/body copy. */
export function productTitle(slug: string): string {
  return products[slug]?.title ?? slug;
}

/**
 * Whether a product is still unreleased.
 *
 * `status` above is the one place launch state is recorded. Every surface that
 * renders a product — the navbar dropdown, the homepage stack, /products, and
 * the detail page — reads it through here rather than repeating it inline.
 * They used to each hold their own copy and had drifted badly: a now-removed
 * product showed "Live" on some surfaces while Fe3dr showed "Coming soon" on
 * others despite being deployed.
 *
 * Unknown slugs read as coming-soon — never advertise something unconfirmed.
 */
export function isComingSoon(slug: string): boolean {
  return products[slug]?.status !== "available";
}

/**
 * The industries covered by the current lineup, in portfolio order
 * (commerce, food, rentals, healthcare, nutrition). Derived from `products`
 * so the marketing copy that quotes this list can't drift from the actual
 * products again.
 */
export const industryNames: Industry[] = Object.values(products).map(
  (product) => product.industry,
);

/**
 * Full industry list as a sentence-start phrase, e.g.
 * "Commerce, food, rentals, healthcare, nutrition" — used where the original
 * copy read as a standalone list (hero, footer, /about metadata).
 */
export function industryListPlain(): string {
  return industryNames
    .map((name, index) => (index === 0 ? `${name[0].toUpperCase()}${name.slice(1)}` : name))
    .join(", ");
}

/**
 * Joins names with an Oxford "and" before the last item, e.g.
 * "food, rentals, healthcare, and nutrition". Shared by every industry-list
 * helper below so the join rules (1 -> "x", 2 -> "x and y", 3+ -> "x, y, and
 * z") exist in exactly one place.
 */
function oxfordJoin(names: string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Industry list with one name excluded and an Oxford "and" before the last
 * item, e.g. industryListExcluding("commerce") => "food, rentals, healthcare,
 * and nutrition" — used for mid-sentence copy that already names the
 * excluded industry's product separately (e.g. the about-teaser statement,
 * which names Mark8ly/commerce in the sentence before this list).
 */
export function industryListExcluding(exclude: Industry): string {
  return oxfordJoin(industryNames.filter((name) => name !== exclude));
}

/**
 * Industries of products that haven't launched yet, with an Oxford "and", e.g.
 * "rentals, healthcare, and nutrition". Copy that names the shipped products
 * individually and then points at what's still in build reads this, so the
 * sentence re-balances itself the moment a product's status flips.
 */
export function upcomingIndustryList(): string {
  return oxfordJoin(
    Object.values(products)
      .filter((product) => product.status !== "available")
      .map((product) => product.industry),
  );
}
