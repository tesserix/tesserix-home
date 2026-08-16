import { defineConfig, globalIgnores } from "eslint/config";
import { libraryConfig } from "@tesserix/eslint-config/library";

// Plain TypeScript library — no React, no Next. See @tesserix/eslint-config's
// library.mjs for why this composes typescript-eslint rather than the Next
// presets the apps use.
const eslintConfig = defineConfig([
  globalIgnores(["dist/**"]),
  ...libraryConfig,
]);

export default eslintConfig;
