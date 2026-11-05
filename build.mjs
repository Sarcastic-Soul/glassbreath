// Bundles the renderer, preload and playground entries with esbuild.
// Usage: node build.mjs [--watch]
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'warning', legalComments: 'none' };

const configs = [
  { ...common, entryPoints: ['src/renderer/app.js'], outfile: 'dist/renderer.js', platform: 'browser', format: 'iife' },
  // App styles, with fonts and the icon font copied next to the bundle so the app works offline.
  { ...common, entryPoints: ['src/renderer/styles.css'], outfile: 'dist/styles.css', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file' }, assetNames: 'assets/[name]-[hash]' },
  { ...common, entryPoints: ['playground/glass.js'], outfile: 'dist/playground-glass.js', platform: 'browser', format: 'iife' },
  // The preload runs sandboxed, so it cannot require node_modules at runtime.
  // Bundling inlines @smartspectra/node-sdk/preload, which only needs `electron`.
  { ...common, entryPoints: ['src/preload/preload.js'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
];

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
  console.log('esbuild watching...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
