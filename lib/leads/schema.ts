// lib/leads/schema.ts — Zod schemas for lead inputs.

import { z } from "zod";

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
] as const;

export const leadStatusSchema = z.enum(LEAD_STATUSES);

// Insert / import shape. email is the only required field.
export const leadInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(200).optional().nullable(),
  company: z.string().trim().max(200).optional().nullable(),
  source: z.string().trim().max(100).optional().nullable(),
  status: leadStatusSchema.optional().default("new"),
  notes: z.string().trim().max(10_000).optional().nullable(),
  owner: z.string().trim().email().optional().nullable(),
});

// Update shape — all fields optional, status restricted.
export const leadUpdateSchema = leadInputSchema.partial().extend({
  last_contacted_at: z.coerce.date().optional().nullable(),
});

// Bulk import payload (paste-JSON or parsed CSV).
export const leadImportSchema = z.object({
  source: z.string().trim().min(1).max(100),
  filename: z.string().trim().max(500).optional().nullable(),
  rows: z.array(leadInputSchema).min(1).max(10_000),
});

export type LeadInput = z.infer<typeof leadInputSchema>;
export type LeadUpdate = z.infer<typeof leadUpdateSchema>;
export type LeadImport = z.infer<typeof leadImportSchema>;
