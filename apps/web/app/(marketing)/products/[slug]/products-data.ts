import {
  ShoppingBag,
  Users,
  Palette,
  CreditCard,
  Package,
  BarChart,
  Shield,
  ChefHat,
  Utensils,
  Truck,
  Star,
  Clock,
  Hospital,
  Stethoscope,
  Calendar,
  FileText,
  Pill,
  UserCheck,
  Trophy,
  MessageCircle,
  TrendingUp,
  Bell,
  Zap,
  Users2,
} from "lucide-react";

export const products: Record<
  string,
  {
    title: string;
    tagline: string;
    description: string;
    longDescription: string;
    icon: React.ComponentType<{ className?: string }>;
    status: "available" | "coming-soon";
    features: Array<{
      icon: React.ComponentType<{ className?: string }>;
      title: string;
      description: string;
    }>;
    benefits: string[];
    // Live products only. A product that hasn't shipped has no prices to quote,
    // so its page shows the launch notice where the pricing card would be.
    pricing?: {
      starter: string;
      professional: string;
      enterprise: string;
    };
    website?: string;
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
        title: "Up to 100 products on Starter",
        description:
          "Studio and Pro are unlimited. Add as many products, photos, and variants as you like as you grow.",
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
      "Optional white-label mobile app on Pro",
      "Three plans, one price page — no bait and switch",
    ],
    pricing: {
      starter: "$19/mo",
      professional: "$49/mo (Studio)",
      enterprise: "$119/mo (Pro)",
    },
  },
  homechef: {
    title: "HomeChef",
    tagline: "Home Cooked Food Delivery Platform",
    description:
      "Connect home chefs with food lovers for authentic, home-cooked meal delivery.",
    longDescription:
      "HomeChef is a complete platform that connects talented home cooks with hungry customers in their community. From chef onboarding and menu management to order tracking and delivery coordination, HomeChef provides everything you need to run a successful home food delivery business.",
    icon: ChefHat,
    status: "available",
    features: [
      {
        icon: UserCheck,
        title: "Chef Onboarding & Verification",
        description:
          "Streamlined chef registration with identity verification, food safety certifications, and kitchen inspections.",
      },
      {
        icon: Utensils,
        title: "Menu Management",
        description:
          "Easy-to-use tools for chefs to create, update, and manage their menus with photos, pricing, and availability.",
      },
      {
        icon: Clock,
        title: "Real-time Order Tracking",
        description:
          "Live order status updates for customers from preparation to delivery with ETA notifications.",
      },
      {
        icon: Truck,
        title: "Delivery Coordination",
        description:
          "Integrated delivery management with route optimization, driver assignment, and live tracking.",
      },
      {
        icon: Star,
        title: "Reviews & Ratings",
        description:
          "Built-in review system to build trust and help customers discover the best home chefs.",
      },
      {
        icon: CreditCard,
        title: "Secure Payments",
        description:
          "Multiple payment options with automatic chef payouts and transparent fee structure.",
      },
    ],
    benefits: [
      "Support local home chefs in your community",
      "Authentic home-cooked meals delivered fresh",
      "Quality control and food safety compliance",
      "Flexible scheduling for chefs",
      "Customer loyalty programs",
      "Mobile apps for iOS and Android",
    ],
    pricing: {
      starter: "$79/month",
      professional: "$199/month",
      enterprise: "Custom",
    },
  },
  medicare: {
    title: "MediCare",
    tagline: "Complete Hospital Management System",
    description:
      "End-to-end hospital management solution for clinics and hospitals of all sizes.",
    longDescription:
      "MediCare is a comprehensive hospital management system designed to streamline healthcare operations. From patient registration and electronic health records to appointment scheduling, billing, and inventory management, MediCare digitizes every aspect of hospital administration.",
    icon: Hospital,
    status: "coming-soon",
    features: [
      {
        icon: FileText,
        title: "Electronic Health Records",
        description:
          "Secure, centralized patient records with medical history, prescriptions, lab results, and imaging.",
      },
      {
        icon: Calendar,
        title: "Appointment Scheduling",
        description:
          "Smart scheduling system with doctor availability, patient reminders, and waitlist management.",
      },
      {
        icon: CreditCard,
        title: "Billing & Insurance",
        description:
          "Automated billing, insurance claim processing, and payment tracking with detailed financial reports.",
      },
      {
        icon: Pill,
        title: "Pharmacy & Inventory",
        description:
          "Complete pharmacy management with drug inventory, expiry tracking, and prescription fulfillment.",
      },
      {
        icon: Users,
        title: "Staff Management",
        description:
          "Employee scheduling, attendance tracking, payroll integration, and performance management.",
      },
      {
        icon: Stethoscope,
        title: "Lab & Diagnostics",
        description:
          "Lab test ordering, result tracking, and integration with diagnostic equipment for seamless workflows.",
      },
    ],
    benefits: [
      "Reduce administrative overhead by 60%",
      "HIPAA compliant data security",
      "Improve patient care coordination",
      "Real-time bed and resource management",
      "Multi-location support",
      "Integration with medical devices",
    ],
  },
  fanzone: {
    title: "FanZone Battle Ground",
    tagline: "Your cricket opinions finally matter",
    description:
      "Live predictions, trash-talk battle rooms, and ranked fan leaderboards.",
    longDescription:
      "FanZone Battle Ground is a competitive fan engagement platform for cricket. Predict match outcomes, hop into live battle rooms during play, and climb ranked leaderboards. Built for IPL die-hards, fantasy players, and anyone who watches with strong opinions.",
    icon: Trophy,
    status: "coming-soon",
    features: [
      {
        icon: Zap,
        title: "Live Match Scores",
        description:
          "Real-time cricket action and statistics with ball-by-ball tracking and key match moments.",
      },
      {
        icon: MessageCircle,
        title: "Battle Rooms",
        description:
          "Live competitive commentary and trash-talk during matches. Defend your team, call your shots, react to every wicket.",
      },
      {
        icon: TrendingUp,
        title: "Predictions Game",
        description:
          "Test your instincts on match outcomes. Stake points on calls; build a track record over the season.",
      },
      {
        icon: Trophy,
        title: "Leaderboards",
        description:
          "Ranked standings for top fans. Climb week-on-week through accurate predictions and active battle play.",
      },
      {
        icon: Users2,
        title: "Hot Takes & Fan Connect",
        description:
          "Share your opinions in structured posts, react to other fans' takes, and find your people.",
      },
      {
        icon: Bell,
        title: "Match Alerts",
        description:
          "Never miss a wicket or milestone with customizable alerts for your favorite teams and players.",
      },
    ],
    benefits: [
      "Live battle rooms during every match",
      "Match-by-match prediction markets",
      "Ranked seasonal leaderboards",
      "Hot takes and fan connect feeds",
      "Alerts for your teams and players",
      "IPL, internationals, and local leagues",
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
 * They used to each hold their own copy and had drifted badly: FanZone showed
 * "Live" on three of them while HomeChef showed "Coming soon" despite being
 * deployed.
 *
 * Unknown slugs read as coming-soon — never advertise something unconfirmed.
 */
export function isComingSoon(slug: string): boolean {
  return products[slug]?.status !== "available";
}
