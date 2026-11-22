import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // El prompt, la base de conocimiento y la agenda se leen en tiempo de ejecución:
  // hay que incluirlos en las funciones serverless de Vercel.
  outputFileTracingIncludes: {
    "/api/**/*": ["./agent-config/**/*"],
  },
};

export default nextConfig;
