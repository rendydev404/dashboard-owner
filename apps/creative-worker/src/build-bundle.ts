// Membangun bundle Remotion sekali (saat build image) ke folder tujuan; render runtime memakainya lewat BUNDLE_DIR.
import { bundle } from "@remotion/bundler";
import path from "node:path";
import { fileURLToPath } from "node:url";

const out = path.resolve(process.argv[2] ?? process.env.BUNDLE_DIR ?? "bundle");
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "remotion-entry.ts");
await bundle({ entryPoint: entry, outDir: out });
console.log("Bundle siap:", out);
