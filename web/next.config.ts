import type { NextConfig } from "next";

// COOP/COEP make the document cross-origin isolated, which enables
// SharedArrayBuffer, which multi-threaded Stockfish WASM requires.
// Production gets these from public/_headers (Workers Static Assets);
// headers() below only covers `next dev` (it is ignored by `output: "export"`).
const crossOriginIsolationHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];

const nextConfig: NextConfig = {
  output: "export",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: crossOriginIsolationHeaders,
      },
    ];
  },
};

export default nextConfig;
