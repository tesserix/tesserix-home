import { expect, it } from "vitest";
import { isResearchPath } from "@tesserix/questionnaires";
it.each([
  "/vending-customers",
  "/vending-business",
  "/questionnaire",
  "/questionnaire/privacy",
])("excludes research path %s from marketing analytics", (path) => {
  expect(isResearchPath(path)).toBe(true);
});
it.each(["/", "/products", "/contact", "/vending-customers-unrelated"])(
  "preserves marketing analytics for %s",
  (path) => {
    expect(isResearchPath(path)).toBe(false);
  },
);
