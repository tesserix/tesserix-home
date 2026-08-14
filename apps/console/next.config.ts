import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",

  // Trace files from the monorepo root so the standalone bundle includes the
  // hoisted workspace node_modules (server.js emits at apps/console/server.js).
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
};

export default nextConfig;
