import type { NextConfig } from "next";
import { fileURLToPath } from "url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  // Allow dev requests when accessing the app via LAN reverse proxy / non-local origins.
  allowedDevOrigins: [
    "http://192.168.5.0",
    "https://192.168.5.0",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ],

  // Prevent Next from inferring the wrong workspace root (we have multiple lockfiles elsewhere).
  turbopack: {
    root: projectRoot,
  },

  /* config options here */
};

export default nextConfig;
