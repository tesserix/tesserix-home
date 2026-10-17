import { z } from "zod";
import { CURRENCIES } from "./index";
export const countrySchema = z.object({
  code: z.string().regex(/^[A-Z]{2}$/),
  name: z.string().min(1).max(100),
  currency: z.enum(CURRENCIES),
});
export type Country = z.infer<typeof countrySchema>;
export const addressSchema = z.object({
  description: z.string().min(1).max(500),
  line1: z.string().max(200),
  city: z.string().max(200),
  region: z.string().max(200),
  postal: z.string().max(200),
  country: z.string().regex(/^[A-Z]{2}$/),
});
export type VenueAddress = z.infer<typeof addressSchema>;
export const lookupSchema = z.strictObject({
  q: z.string().trim().min(3).max(150),
  country: z.string().regex(/^[A-Z]{2}$/),
});
// Snapshot of the existing public catalog: manual completion survives a catalog outage.
export const fallbackCountries: Country[] = [
  ["AU", "Australia", "AUD"],
  ["BR", "Brazil", "BRL"],
  ["CA", "Canada", "CAD"],
  ["FR", "France", "EUR"],
  ["DE", "Germany", "EUR"],
  ["IN", "India", "INR"],
  ["ID", "Indonesia", "IDR"],
  ["IT", "Italy", "EUR"],
  ["JP", "Japan", "JPY"],
  ["MY", "Malaysia", "MYR"],
  ["NL", "Netherlands", "EUR"],
  ["NZ", "New Zealand", "NZD"],
  ["PH", "Philippines", "PHP"],
  ["SA", "Saudi Arabia", "SAR"],
  ["SG", "Singapore", "SGD"],
  ["ES", "Spain", "EUR"],
  ["TH", "Thailand", "THB"],
  ["AE", "United Arab Emirates", "AED"],
  ["GB", "United Kingdom", "GBP"],
  ["US", "United States", "USD"],
].map(([code, name, currency]) =>
  countrySchema.parse({ code, name, currency }),
);
