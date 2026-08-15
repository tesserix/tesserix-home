// Icons are string keys, never component references — console-core has zero
// renderer-specific code, so it cannot import an icon library. Each app maps
// these keys to its own renderer's icon components (lucide-react on web,
// a native equivalent on mobile).
export type IconKey =
  | "layout-dashboard"
  | "database"
  | "scroll-text"
  | "message-square"
  | "users"
  | "inbox"
  | "settings"
  | "activity"
  // Added for the platform rail. Each app's icon registry is typed
  // `Record<IconKey, ...>`, so adding a key here is a COMPILE error in every
  // renderer until it maps one — never a blank icon at runtime.
  | "cloud"
  | "life-buoy"
  | "bar-chart"
  | "megaphone"
  | "heart-pulse"
  | "gauge"
  | "globe"
  | "mail"
  | "shield"
  | "key-round";
