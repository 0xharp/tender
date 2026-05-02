import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Cloak SDK ships browser-incompatible code that calls Node's full
  // `Buffer.readBigInt64LE()`. Next 16's default browser shim doesn't expose
  // BigInt-aware methods, so we alias `buffer` everywhere to the full
  // `buffer` npm package (which DOES have them). Affects both Turbopack (dev)
  // and webpack (production build) so behavior is consistent.
  turbopack: {
    resolveAlias: {
      buffer: 'buffer',
    },
  },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.fallback = {
      ...(config.resolve.fallback || {}),
      buffer: require.resolve('buffer/'),
    };
    return config;
  },
};

export default nextConfig;
