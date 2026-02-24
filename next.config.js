/** @type {import('next').NextConfig} */
const nextConfig = {
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