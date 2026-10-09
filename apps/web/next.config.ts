import type { NextConfig } from 'next';
import path from 'node:path';

const apiInternalUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Monorepo: trace dependencies from the repository root so @pegpal/shared is bundled.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  transpilePackages: ['@pegpal/shared'],
  // SSE through the rewrite must not be buffered/compressed.
  compress: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiInternalUrl}/api/:path*` }];
  },
};

export default nextConfig;
