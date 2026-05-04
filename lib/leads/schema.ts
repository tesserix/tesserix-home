// lib/leads/schema.ts — Zod schemas for lead inputs.
//
// As of migration 0007 the leads table supports multi-channel contacts
// (email | phone | instagram_handle, at least one required) plus
// structured fields for filtering. Schemas mirror the DB CHECK
// constraint so the API rejects zero-contact rows up front.

import { z } from "zod";

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "converted",
  "lost",
] as const;

export const leadStatusSchema = z.enum(LEAD_STATUSES);

// Email column accepts either a valid address or empty/null. The empty
// string transforms to null so form submissions with a blank field
// don't fail the email() check.
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .optional()
  .nullable()
  .or(z.literal("").transform(() => null));

// Insert / import shape. The DB CHECK enforces "at least one contact",
// so the schema-level refinement is the matching front gate.
export const leadInputSchema = z
  .object({
    email: emailField,
    instagram_handle: z.string().trim().max(100).optional().nullable(),
    phone: z.string().trim().max(40).optional().nullable(),
    name: z.string().trim().max(200).optional().nullable(),
    company: z.string().trim().max(200).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    category: z.array(z.string().trim().max(100)).optional().default([]),
    has_website: z.boolean().optional().nullable(),
    website_url: z.string().trim().max(500).optional().nullable(),
    biography: z.string().trim().max(10_000).optional().nullable(),
    tags: z.array(z.string().trim().max(100)).optional().default([]),
    source: z.string().trim().max(100).optional().nullable(),
    status: leadStatusSchema.optional().default("new"),
    notes: z.string().trim().max(10_000).optional().nullable(),
    owner: z.string().trim().email().optional().nullable(),
  })
  .refine(
    (v) =>
      Boolean(
        (v.email && v.email.length > 0) ||
          (v.phone && v.phone.length > 0) ||
          (v.instagram_handle && v.instagram_handle.length > 0),
      ),
    {
      message: "at least one of email, phone, or instagram_handle is required",
      path: ["email"],
    },
  );

// Update shape — all fields optional, status restricted. The
// contact-present CHECK is enforced at the DB layer so update payloads
// don't need to re-prove it (you may legitimately patch only `status`
// or `notes`). Defined as its own object (rather than .partial() on
// the input schema) because z.refine() removes .partial() support.
export const leadUpdateSchema = z.object({
  email: emailField,
  instagram_handle: z.string().trim().max(100).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  name: z.string().trim().max(200).optional().nullable(),
  company: z.string().trim().max(200).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  category: z.array(z.string().trim().max(100)).optional(),
  has_website: z.boolean().optional().nullable(),
  website_url: z.string().trim().max(500).optional().nullable(),
  biography: z.string().trim().max(10_000).optional().nullable(),
  tags: z.array(z.string().trim().max(100)).optional(),
  source: z.string().trim().max(100).optional().nullable(),
  status: leadStatusSchema.optional(),
  notes: z.string().trim().max(10_000).optional().nullable(),
  owner: z.string().trim().email().optional().nullable(),
  last_contacted_at: z.coerce.date().optional().nullable(),
});

// Bulk import payload (paste-JSON or parsed CSV). Each row is a full
// leadInputSchema — same contact-present rule as the single-insert
// shape.
export const leadImportSchema = z.object({
  source: z.string().trim().min(1).max(100),
  filename: z.string().trim().max(500).optional().nullable(),
  rows: z.array(leadInputSchema).min(1).max(10_000),
});

export type LeadInput = z.infer<typeof leadInputSchema>;
export type LeadUpdate = z.infer<typeof leadUpdateSchema>;
export type LeadImport = z.infer<typeof leadImportSchema>;
