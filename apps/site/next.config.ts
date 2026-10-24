import type { NextConfig } from 'next';

// The marketing site is fully static: every page is exported to HTML at build time.
const config: NextConfig = {
  output: 'export',
  trailingSlash: false,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default config;
