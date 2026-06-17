// Bundle the bridge + orchestrator (TypeScript) into a single plain-JS file so
// the packaged Electron app runs it on Electron's Node — no tsx at runtime.
//
//   node scripts/build-server.mjs   ->   dist-server/bridge.cjs

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Our TS files import each other with `.js` specifiers (NodeNext convention);
// map those to the real `.ts` sources during bundling.
const jsToTs = {
  name: 'js-to-ts',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === 'entry-point' || !args.path.startsWith('.')) return;
      const ts = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      return existsSync(ts) ? { path: ts } : undefined;
    });
  },
};

await build({
  entryPoints: [resolve(ROOT, 'server/bridge.mjs')],
  bundle: true,
  platform: 'node',
  // ESM output: Electron's Node (20) can't require() the ESM SDK, but it can
  // import it. ESM also gives us native import.meta.url (no shim).
  format: 'esm',
  target: 'node20',
  outfile: resolve(ROOT, 'dist-server/bridge.mjs'),
  // Keep in node_modules (resolved at runtime): the SDK ships a platform binary;
  // express is CJS with dynamic requires.
  external: ['@anthropic-ai/claude-agent-sdk', 'express'],
  plugins: [jsToTs],
  logLevel: 'info',
});

console.log('built dist-server/bridge.mjs');
