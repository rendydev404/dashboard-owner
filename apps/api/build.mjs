// Bundel API jadi satu file (paket shared ikut di-inline). Native module tetap eksternal.
import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts", "src/cli/migrate.ts", "src/cli/user-create.ts", "src/cli/seed-demo.ts"],
  outdir: "dist",
  outbase: "src",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["@node-rs/argon2"],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
