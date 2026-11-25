import { z } from "zod";

const key = z.string().regex(/^[a-z][a-z_]{0,63}$/);
const revision = z.string().regex(/^[0-9a-f]{64}$/);
export const featureFlagCommandSchema = z.object({
  id: z.string().uuid(),
  actor: z.string().min(1).max(200),
  key,
  enabled: z.boolean(),
  reason: z.string().min(8).max(500),
  state: z.enum(["queued", "dispatching", "succeeded", "failed", "in_doubt"]),
  code: z.string().max(128),
  provider_version: z.number().int().nonnegative().nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export const featureFlagCommandsSchema = z
  .array(featureFlagCommandSchema)
  .max(20);
const flagSchema = z.object({
  provisioned: z.boolean().default(true),
  key,
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  group: z.string().min(1).max(100),
  enabled: z.boolean(),
  eligible: z.boolean(),
  pilot_only: z.boolean().default(false),
  available: z.boolean(),
  dependencies: z.array(key).max(100),
  blocked_by: z.array(key).max(100),
  impact_when_enabled: z.array(key).max(100),
  impact_when_disabled: z.array(key).max(100),
});
const snapshotSchema = z
  .object({
    product: z.literal("helivanta"),
    environment: z.literal("production"),
    policy_version: z.string().min(1).max(128),
    revision,
    flags: z.array(flagSchema).min(1).max(100),
    commands: featureFlagCommandsSchema,
  })
  .superRefine((snapshot, ctx) => {
    const flags = new Map(snapshot.flags.map((flag) => [flag.key, flag]));
    if (flags.size !== snapshot.flags.length)
      ctx.addIssue({ code: "custom", message: "Duplicate feature flags" });
    for (const flag of snapshot.flags) {
      if (flag.pilot_only && !flag.eligible)
        ctx.addIssue({
          code: "custom",
          message: "An editable pilot must be policy-eligible.",
        });
      if (!flag.provisioned && (flag.enabled || flag.available)) {
        ctx.addIssue({
          code: "custom",
          message: "An unprovisioned flag cannot be enabled or available.",
        });
      }
      if (
        flag.available &&
        (!flag.enabled ||
          !flag.eligible ||
          flag.dependencies.some((dep) => !flags.get(dep)?.available))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Inconsistent feature availability",
        });
      }
      if (
        [
          ...flag.dependencies,
          ...flag.blocked_by,
          ...flag.impact_when_enabled,
          ...flag.impact_when_disabled,
        ].some((dep) => !flags.has(dep) || dep === flag.key)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Unknown feature dependency or impact",
        });
      }
      if (flag.blocked_by.some((dep) => !flag.dependencies.includes(dep)))
        ctx.addIssue({
          code: "custom",
          message: "Invalid blocking dependency",
        });
    }
  });
export const featureFlagChangeSchema = z
  .object({
    request_key: z.string().uuid(),
    key,
    enabled: z.boolean(),
    expected_revision: revision,
    reason: z
      .string()
      .trim()
      .min(8, "Explain the change in at least 8 characters.")
      .max(500)
      .refine((value) => !/\p{Cc}/u.test(value), "Use a single line of text."),
  })
  .strict();
export const featureFlagProductsSchema = z
  .array(
    z.object({
      id: z.literal("helivanta"),
      name: z.string().min(1).max(100),
      description: z.string().max(500),
      configured: z.boolean(),
    }),
  )
  .min(1)
  .max(1);
export const parseFeatureFlagSnapshot = (value: unknown) =>
  snapshotSchema.parse(value);
export type FeatureFlagSnapshot = z.infer<typeof snapshotSchema>;
export type FeatureFlag = z.infer<typeof flagSchema>;
export type FeatureFlagCommand = z.infer<typeof featureFlagCommandSchema>;
export type FeatureFlagChange = z.infer<typeof featureFlagChangeSchema>;
export type FeatureFlagWriteResult = {
  ok: boolean;
  message: string;
  command?: FeatureFlagCommand;
};
export const unresolvedCommand = (command: FeatureFlagCommand) =>
  ["queued", "dispatching", "in_doubt"].includes(command.state);
