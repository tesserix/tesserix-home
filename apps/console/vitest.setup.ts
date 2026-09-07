import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// React only flushes `act()` synchronously when it believes it is in a test
// environment. Without this flag a React 19 root renders asynchronously and
// every `render()` returns an empty container.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Vitest runs without `globals`, so Testing Library's automatic cleanup hook
// never registers itself. Unmount between tests explicitly, or a component
// left mounted by one test is still queryable from the next.
afterEach(() => {
  cleanup();
});

// jsdom implements NONE of the Pointer Capture API and no `scrollIntoView`.
// Radix UI's `Select` — the design system's `Select`, used on the CRM create
// form and on `platform/secrets/new` — calls `hasPointerCapture` on
// pointerdown and `scrollIntoView` when it opens its listbox, so without
// these a test that clicks the trigger throws instead of opening the menu.
// These four stubs are what make a Radix `Select` driveable under jsdom for
// the whole console.
//
// Deliberately no-ops returning the "not captured" answer: nothing under
// test asserts on pointer capture itself, only on what Radix does once it
// stops throwing.
if (typeof Element !== "undefined") {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
}

// The same class of gap, for the same reason: Radix's `Checkbox` measures its
// hidden bubble input with `useSize`, which constructs a `ResizeObserver`
// jsdom does not implement — so RENDERING one throws, before any assertion.
// Three CRM suites already carry this stub locally; it lives here so a surface
// that adopts the design system's `Checkbox` (the promo scope controls,
// `ConsoleDataTable`'s row selection) does not have to rediscover why its
// render failed. `??=` so a suite that installs its own spy keeps it.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
