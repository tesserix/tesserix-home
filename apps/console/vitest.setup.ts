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
