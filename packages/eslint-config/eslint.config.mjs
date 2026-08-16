import { defineConfig } from "eslint/config";
// Relative, not "@tesserix/eslint-config/library": a package importing its own
// name would need to depend on itself. Every other package uses the bare
// specifier — see packages/console-core/eslint.config.mjs.
import { libraryConfig } from "./library.mjs";

const eslintConfig = defineConfig([...libraryConfig]);

export default eslintConfig;
