// Icons are string keys, never component references — console-core has zero
// renderer-specific code, so it cannot import an icon library. The consuming
// app maps these keys to its own renderer's icon components.
//
// WHAT A NEW KEY ACTUALLY COSTS, because nav.ts used to misprice it in nine
// places: one entry in one registry. `apps/console` is the only package that
// depends on `@tesserix/console-core`, and its
// `components/nav/icon.tsx` holds the only `Record<IconKey, ...>` in the repo.
// `apps/web` and `apps/mobile` build their rails from their own config and
// never import this type, so a key added here cannot break them. Pick an
// existing key when it says something true about the surface — not to avoid a
// cost that is one line.
export type IconKey =
  | "layout-dashboard"
  | "database"
  | "scroll-text"
  | "message-square"
  | "users"
  | "inbox"
  | "settings"
  | "activity"
  // Added for the platform rail. The console's icon registry is typed
  // `Record<IconKey, ...>`, so adding a key here is a COMPILE error there
  // until it maps one — never a blank icon at runtime.
  | "cloud"
  | "life-buoy"
  | "bar-chart"
  | "megaphone"
  | "heart-pulse"
  | "gauge"
  | "globe"
  | "mail"
  | "shield"
  | "key-round"
  // A task list, for a rail entry that is work to be done rather than a
  // record or a directory. Added because the three unused keys above
  // (`activity`, `gauge`, `heart-pulse`) are all metric/health glyphs.
  | "list-checks";
