/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
devIndicators: false,
  async redirects() {
    return [
      {
        source: '/',
        destination: '/trips',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;