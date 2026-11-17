import "server-only";
import { platformRequestWithMeta } from "./platform-api";
import {
  featureFlagProductsSchema,
  parseFeatureFlagSnapshot,
  featureFlagCommandsSchema,
} from "./feature-flags-contract";

export async function fetchFeatureFlagProducts() {
  const { data } = await platformRequestWithMeta(
    "feature flags",
    "/v1/platform/feature-flags",
    { signal: AbortSignal.timeout(15_000) },
  );
  return featureFlagProductsSchema.parse(data);
}
export async function fetchHelivantaFeatureFlags() {
  const { data } = await platformRequestWithMeta(
    "feature flags",
    "/v1/platform/feature-flags/helivanta",
    { signal: AbortSignal.timeout(15_000) },
  );
  return parseFeatureFlagSnapshot(data);
}
export async function fetchHelivantaFlagCommands() {
  const { data } = await platformRequestWithMeta(
    "feature flag history",
    "/v1/platform/feature-flags/helivanta/commands",
    { signal: AbortSignal.timeout(15_000) },
  );
  return featureFlagCommandsSchema.parse(data);
}
