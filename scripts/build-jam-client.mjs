// Bundles the static joiner page into jam-client/dist (served by the relay and
// copied into the Android app's assets).
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "jam-client", "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [path.join(root, "jam-client", "src", "main.ts")],
  bundle: true,
  minify: true,
  target: "es2019",
  outfile: path.join(dist, "app.js"),
  logLevel: "warning",
});
fs.copyFileSync(path.join(root, "jam-client", "index.html"), path.join(dist, "index.html"));
console.log("jam-client built →", path.relative(root, dist));
