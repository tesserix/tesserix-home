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
    pricing: {
      starter: string;
      professional: string;
      enterprise: string;
    };
    github?: string;
    website?: string;
  }
> = {
  mark8ly: {
    title: "Mark8ly",
    tagline: "The simplest way to create and launch your online store",
    description:
      "Your online store, ready this afternoon. No developer needed.",
    website: "https://mark8ly.com",
    longDescription:
      "Set up your store in under an hour — no developer needed. Skip the expensive customization costs and do it yourself. Beautiful themes you can customize to match your brand, integrated payments, built-in SEO tools, and real human support. Built for creators, makers, and small businesses who want to focus on selling, not software.",
    icon: ShoppingBag,
    status: "available",
    features: [
      {
        icon: Palette,
        title: "Make It Yours",
        description:
          "Beautiful themes you can customize to match your brand. No design skills needed. Your store looks great on every device.",
      },
      {
        icon: CreditCard,
        title: "Sell Everywhere",
        description:
          "Accept cards, UPI, and wallets. No platform transaction fees — your money is your money.",
      },
      {
        icon: BarChart,
        title: "Know Your Numbers",
        description:
          "Simple analytics that help you understand what's working and what's not. Track revenue, orders, and visitors.",
      },
      {
        icon: Package,
        title: "Unlimited Products",
        description:
          "Add as many products as you want with unlimited photos. Organize your catalog with categories and collections.",
      },
      {
        icon: Shield,
        title: "SSL Secured & 99.9% Uptime",
        description:
          "Enterprise-grade security with SSL encryption on every store. Your customers' data is always protected.",
      },
      {
        icon: Users,
        title: "Real Human Support",
        description:
          "No chatbots, just friendly support ready to help when you need it. Average response time under 4 hours.",
      },
    ],
    benefits: [
      "12 months free, then just ₹499/month",
      "No transaction fees from platform",
      "No developer needed — set up yourself",
      "Custom domain support",
      "Shopify migration support",
      "Cancel anytime, export all your data",
    ],
    pricing: {
      starter: "Free for 12 months",
      professional: "₹499/month",
      enterprise: "Custom",
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
    status: "coming-soon",
    github: "https://github.com/Tesseract-Nexus/Home-Chef-App",
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
    github: "https://github.com/Tesseract-Nexus/hospital-management",
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
    pricing: {
      starter: "$199/month",
      professional: "$499/month",
      enterprise: "Custom",
    },
  },
  fanzone: {
    title: "FanZone",
    tagline: "Cricket Live Scores & Banter",
    description:
      "The ultimate cricket fan experience with live scores, predictions, and community.",
    longDescription:
      "FanZone brings cricket fans together with real-time match updates, ball-by-ball commentary, match predictions, and a vibrant community for discussions and banter. Whether you're following IPL, international matches, or local leagues, FanZone keeps you connected to the game you love.",
    icon: Trophy,
    status: "coming-soon",
    github: "https://github.com/Tesseract-Nexus/FanZone-Battle-Ground",
    features: [
      {
        icon: Zap,
        title: "Live Match Scores",
        description:
          "Real-time score updates with ball-by-ball tracking, run rates, and key match statistics.",
      },
      {
        icon: MessageCircle,
        title: "Ball-by-Ball Commentary",
        description:
          "Expert commentary on every delivery with insights, analysis, and memorable moments.",
      },
      {
        icon: TrendingUp,
        title: "Match Predictions",
        description:
          "Predict match outcomes, player performances, and compete with friends on leaderboards.",
      },
      {
        icon: Users2,
        title: "Fan Discussions & Polls",
        description:
          "Join the conversation with live match threads, polls, and community discussions.",
      },
      {
        icon: BarChart,
        title: "Player Statistics",
        description:
          "Comprehensive player stats, career records, head-to-head comparisons, and performance trends.",
      },
      {
        icon: Bell,
        title: "Push Notifications",
        description:
          "Never miss a wicket or milestone with customizable alerts for your favorite teams and players.",
      },
    ],
    benefits: [
      "Follow all major cricket tournaments",
      "Compete with friends in prediction leagues",
      "Build your cricket fan profile",
      "Access historical match data",
      "Ad-free premium experience",
      "Available on web and mobile",
    ],
    pricing: {
      starter: "Free",
      professional: "$9.99/month",
      enterprise: "Custom",
    },
  },
};
