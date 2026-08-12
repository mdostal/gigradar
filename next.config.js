// Minimal Next.js config — only what's needed to run cleanly. `type: "module"`
// in package.json means this file is parsed as ESM, so `export default` (not
// `module.exports`) is required here.
/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Default Server Action body limit is 1MB — too small for a real resume
    // PDF upload (resume-link-ui story, profile-overview-ingestion epic).
    // Scoped here rather than per-route since Next doesn't support a
    // per-action override; 10MB comfortably covers a realistic resume PDF
    // while still bounding the request body.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  webpack: (config) => {
    // src/lib/* (see src/lib/store/index.ts) uses NodeNext-style explicit
    // `.js` extensions on its relative imports (required for tsx/vitest's
    // ESM resolution) even though the files on disk are `.ts`. Next's
    // webpack resolver doesn't map that by default and fails with
    // "Module not found: Can't resolve './db.js'" — this extensionAlias
    // is the fix, scoped to this config rather than touching the
    // already-working lib source.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
