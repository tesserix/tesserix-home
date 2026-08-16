// Flat-config preset for the plain TypeScript library packages in packages/*,
// as opposed to the Next apps in apps/*.
//
// Why this is not eslint-config-next: these packages have no React, no JSX and
// no Next runtime, so the Next presets would load the react, react-hooks,
// jsx-a11y and @next/next plugins with nothing to lint. js + typescript-eslint
// recommended is the equivalent baseline for a library.
//
// Composition mirrors the apps: <base presets> + sharedRules + local overrides.
//
// Note on `sharedRules`: it switches off some react/* and import/* rules whose
// plugins are not loaded here. That is safe — ESLint flat config only errors on
// an unknown plugin's rule when the rule is *enabled*; a severity of "off" is
// ignored. Verified against eslint 9.39.5 by linting these packages with the
// block in place. So the apps and the libraries can keep sharing one block.
//
// Note on this package's own deps: `typescript` is a devDependency here purely
// to pin typescript-eslint's `typescript` peer to 5.9.3. Without it pnpm
// satisfies that peer from the hoisted tree and picks up apps/mobile's
// typescript 6.0.3, duplicating the whole @typescript-eslint subgraph.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { sharedRules } from "./index.mjs";

// Overrides that apply to library packages only. Kept separate from
// `sharedRules` so that changing a library rule can never move what the apps
// are checked against. Empty today — the first lint pass over console-core,
// platform-auth and homechef-shared needed no exemptions.
export const libraryRules = {
  rules: {},
};

export const libraryConfig = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  sharedRules,
  libraryRules,
];
