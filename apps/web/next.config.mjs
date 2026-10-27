/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // lets a production build run (e.g. NEXT_DIST_DIR=.next-build) without clobbering a running dev server
  distDir: process.env.NEXT_DIST_DIR || ".next",
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei", "@react-three/xr"],
  webpack: (config) => {
    config.externals.push({
      "utf-8-validate": "commonjs utf-8-validate",
      bufferutil: "commonjs bufferutil",
    });
    return config;
  },
};

export default nextConfig;
