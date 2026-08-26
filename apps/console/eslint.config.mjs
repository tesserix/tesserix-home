import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { sharedRules } from "@tesserix/eslint-config";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // `dist/` is `build:cron`'s esbuild output — generated, gitignored, and not
  // source anybody edits.
  globalIgnores([".next/**", "out/**", "build/**", "dist/**", "next-env.d.ts"]),
  sharedRules,
  // The kit itself must compose the raw element; everything else uses the kit.
  // `@tesserix/web`'s <Table> is capitalised, so composing it is unaffected —
  // this only fires on a literal lowercase <table>.
  {
    ignores: ["components/kit/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='table']",
          message:
            "Use ConsoleDataTable. 40 files in the old console hand-rolled a table; that is the duplication this kit exists to end.",
        },
      ],
    },
  },
]);

export default eslintConfig;
