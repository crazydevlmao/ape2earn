import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // optional if TS errors ever bite during CI:
  // typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
