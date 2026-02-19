import browserslistToEsbuild from "browserslist-to-esbuild";
import { build } from "esbuild";
import { nodeModulesPolyfillPlugin } from "esbuild-plugins-node-modules-polyfill";
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { mockFsPlugin } from "./build/mock-fs.mjs";

function toBoolean(value) {
  return value === "1" || value === "true" || value === 1 || value === true;
}

await Promise.all([
  build({
    inject: ["./build/process-shim.js"],
    entryPoints: ["src/index.ts"],
    outfile: "output/imported.mjs",
    bundle: true,
    platform: "browser",
    target: browserslistToEsbuild(),
    loader: {
      ".txt.js": "text",
    },
    format: "esm",
    plugins: [
      nodeModulesPolyfillPlugin({
        globals: {
          process: true,
          Buffer: true,
        },
      }),
      mockFsPlugin,
    ],
    sourcemap: !toBoolean(process.env.NO_SOURCE_MAP),
    keepNames: true,
    minify: toBoolean(process.env.MINIFY ?? "true"),
  }),
  build({
    inject: ["./build/process-shim.js"],
    entryPoints: ["src/index.ts"],
    outfile: "output/required.cjs",
    bundle: true,
    platform: "browser",
    target: browserslistToEsbuild(),
    loader: {
      ".txt.js": "text",
    },
    format: "cjs",
    plugins: [
      nodeModulesPolyfillPlugin({
        globals: {
          process: true,
          Buffer: true,
        },
      }),
      mockFsPlugin,
    ],
    sourcemap: !toBoolean(process.env.NO_SOURCE_MAP),
    keepNames: true,
    minify: toBoolean(process.env.MINIFY ?? "true"),
  }),
  build({
    inject: ["./build/process-shim.js"],
    entryPoints: ["src/index.ts"],
    outfile: "output/fallback.js",
    bundle: true,
    platform: "browser",
    target: browserslistToEsbuild(),
    loader: {
      ".txt.js": "text",
    },
    format: "iife",
    plugins: [
      nodeModulesPolyfillPlugin({
        globals: {
          process: true,
          Buffer: true,
        },
      }),
      mockFsPlugin,
    ],
    sourcemap: !toBoolean(process.env.NO_SOURCE_MAP),
    keepNames: true,
    minify: toBoolean(process.env.MINIFY ?? "true"),
  }),
  build({
    inject: ["./build/process-shim.js", "./build/mock-window.js"],
    entryPoints: ["src/worker.ts"],
    outfile: "output/javascript-browser-test-runner-worker.mjs",
    bundle: true,
    platform: "browser",
    target: browserslistToEsbuild(),
    loader: {
      ".txt.js": "text",
    },
    format: "esm",
    plugins: [
      nodeModulesPolyfillPlugin({
        globals: {
          process: true,
          Buffer: true,
        },
      }),
      mockFsPlugin,
    ],
    sourcemap: !toBoolean(process.env.NO_SOURCE_MAP),
    keepNames: true,
    minify: toBoolean(process.env.MINIFY ?? "true"),
  }),
]);

spawnSync('tsc')

const source = join(import.meta.dirname, "output");
const destination = join(import.meta.dirname, "sample");
const files = [
  "imported.mjs",
  "imported.mjs.map",
  "javascript-browser-test-runner-worker.mjs",
  "javascript-browser-test-runner-worker.mjs.map",
];

files.forEach((file) => {
  console.log(join(source, file), join(destination, file));
  copyFileSync(join(source, file), join(destination, file));
});
