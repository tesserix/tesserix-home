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

// Web Storage, which THIS environment supplies only on some Node versions.
//
// `window.localStorage` reads as `undefined` under Node 26 even though the
// document has a real origin and jsdom 30 implements Storage. The cause is an
// interaction, not a missing feature on either side:
//
//   - Node 26 itself defines `globalThis.localStorage` as an accessor, and
//     that accessor returns `undefined` unless the process was started with
//     `--localstorage-file` (it warns exactly that).
//   - vitest's jsdom environment populates globals only for keys jsdom owns
//     that are not already present. `localStorage` IS already present — as
//     Node's own always-undefined accessor — so jsdom's real Storage never
//     lands on it.
//
// Measured rather than assumed, because the boundary is narrower than it
// looks — `hasOwnProperty("localStorage")` on a bare `node -e`:
//
//   v22.19.0  ABSENT      jsdom's Storage lands, suite passes
//   v24.20.0  ABSENT      jsdom's Storage lands, suite passes
//   v26.5.0   present, undefined  jsdom's Storage is shadowed, 25 tests fail
//
// So this is NOT "Node 24+". It is Node 26, and CI (`node-version: '22'` in
// .github/workflows/ci.yml) has always been correctly green — the sidebar
// suite runs there under `pnpm --filter console test:unit` and passes. This
// is a LOCAL-ENVIRONMENT fix for developers on Node 26, not a product defect
// and not a gap in CI coverage.
//
// Confirmed a no-op where it should be: with this block in place the same 25
// tests still pass under v22.19.0, so nothing about CI's behaviour changes.
//
// A real Map-backed implementation rather than no-op stubs: the sidebar tests
// SET a value and assert the component reads it back (#221's collapsed-group
// persistence), so a stub that dropped writes would convert 25 hard failures
// into 25 quiet false passes — strictly worse than the state it replaces.
//
// Guarded on the VALUE being absent, not on the key: `??=` and a plain
// `"localStorage" in globalThis` check both see Node's accessor and skip.
if (typeof globalThis !== "undefined" && !(globalThis as { localStorage?: unknown }).localStorage) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    // Both arguments coerced to strings, as the spec requires — a test that
    // stores a number and asserts on the string it reads back behaves here
    // exactly as it does in a browser.
    setItem: (key: string, value: string) => void store.set(String(key), String(value)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}
