import type { NextConfig } from "next";

// No `transpilePackages`: Turbopack transpiles workspace packages
// automatically under the App Router (see the transpilePackages page in
// node_modules/next/dist/docs).
const nextConfig: NextConfig = {
  typedRoutes: true,
  cacheComponents: true,
};

export default nextConfig;
