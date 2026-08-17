import { defineConfig } from "eslint/config";
import { libraryConfig } from "@tesserix/eslint-config/library";

// Plain JS (JSDoc-typed), not TypeScript — but the same library preset
// applies cleanly: typescript-eslint's recommended rules scope themselves
// to TS file extensions, so they no-op here, and js.configs.recommended
// (also part of libraryConfig) still lints this package's actual source.
// See packages/console-core/eslint.config.mjs for the TS sibling of this
// file, and packages/crm-country/index.mjs for why this package is JS at
// all rather than TS.
const eslintConfig = defineConfig([...libraryConfig]);

export default eslintConfig;
