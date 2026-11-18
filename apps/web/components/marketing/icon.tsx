import {
  BarChart,
  Building2,
  CalendarDays,
  Camera,
  ChefHat,
  CreditCard,
  FileText,
  FlaskConical,
  History,
  Hospital,
  KeyRound,
  Languages,
  MapPin,
  MessageSquare,
  Mic,
  Package,
  Palette,
  Pencil,
  Pill,
  Plane,
  Salad,
  ScanLine,
  Shield,
  ShieldCheck,
  ShoppingBag,
  Truck,
  UserCheck,
  Users,
  Utensils,
  Wallet,
  Wrench,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * The lucide icons marketing content may name. Kept identical to the CMS's
 * `products.icon` select options (tesserix-cms/src/collections/tesserix/icons.ts).
 */
export const ICONS = [
  "BarChart",
  "Building2",
  "CalendarDays",
  "Camera",
  "ChefHat",
  "CreditCard",
  "FileText",
  "FlaskConical",
  "History",
  "Hospital",
  "KeyRound",
  "Languages",
  "MapPin",
  "MessageSquare",
  "Mic",
  "Package",
  "Palette",
  "Pencil",
  "Pill",
  "Plane",
  "Salad",
  "ScanLine",
  "Shield",
  "ShieldCheck",
  "ShoppingBag",
  "Truck",
  "UserCheck",
  "Users",
  "Utensils",
  "Wallet",
  "Wrench",
] as const;

export type IconName = (typeof ICONS)[number];

const components: Record<IconName, ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>> = {
  BarChart, Building2, CalendarDays, Camera, ChefHat, CreditCard, FileText, FlaskConical, History, Hospital,
  KeyRound, Languages, MapPin, MessageSquare, Mic, Package, Palette, Pencil, Pill, Plane, Salad, ScanLine,
  Shield, ShieldCheck, ShoppingBag, Truck, UserCheck, Users, Utensils, Wallet, Wrench,
};

/** Renders the named lucide icon; an unknown name (e.g. a CMS value newer than this build) renders `Package`. */
export function ProductIcon({ name, className }: { name: string; className?: string }) {
  const Icon = components[name as IconName] ?? Package;
  return <Icon className={className} aria-hidden="true" />;
}
