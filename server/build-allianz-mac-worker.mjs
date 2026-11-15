// Builds the Allianz worker for Mark's Mac as ONE file (the lookup and its browser driver inside), so the Mac needs nothing installed but node.
//   node build-allianz-mac-worker.mjs <folder to write allianz-mac-worker.mjs into>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(here, "dist-mac"));
await build({
  entryPoints: [path.join(here, "src/allianz-mac-worker.ts")], outfile: path.join(out, "allianz-mac-worker.mjs"),
  platform: "node", bundle: true, format: "esm", logLevel: "warning", external: ["bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log(`built ${path.join(out, "allianz-mac-worker.mjs")}`);
