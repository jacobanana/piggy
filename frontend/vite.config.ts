import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';

// base './' keeps every asset reference relative, so the same build works at
// https://<user>.github.io/piggy/, on a custom domain, or served by the backend.
// The service worker holds the same line — see the note in src/sw.ts.

/** What is worth precaching. Source maps are shipped but never preloaded. */
const PRECACHE = /\.(html|js|css|svg|png|ico|webmanifest|woff2?)$/i;

/** Written by this plugin, so never a member of its own precache list. */
const WORKER_FILE = 'sw.js';

function walk(dir: string, root: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, root);
    return [posix.join(...relative(root, full).split(/[\\/]/))];
  });
}

/**
 * Compile `src/sw.ts` to `dist/sw.js`, with the build's own output baked in.
 *
 * Runs on `closeBundle` rather than `generateBundle` because the list has to
 * include `public/` — the manifest and the icons are copied straight through
 * and never appear in the bundle, and a worker that precaches the app but not
 * its manifest is one that cannot be installed from a cold start on a train.
 * By `closeBundle` everything is on disk, so the list is simply what shipped.
 *
 * The version is a digest of those files' *contents*, not of the build clock.
 * A rebuild that changed nothing therefore keeps its cache name, and readers
 * are not prompted to reload a version identical to the one they are running.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  let root = process.cwd();

  return {
    name: 'piggy-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files = walk(outDir, outDir)
        .filter((file) => PRECACHE.test(file) && file !== WORKER_FILE)
        .sort();

      const digest = createHash('sha256');
      for (const file of files) {
        digest.update(file);
        digest.update(readFileSync(join(outDir, file)));
      }
      const version = digest.digest('hex').slice(0, 12);

      const source = readFileSync(resolve(root, 'src/sw.ts'), 'utf8');
      const { code } = await transformWithEsbuild(source, resolve(root, 'src/sw.ts'), {
        loader: 'ts',
        format: 'iife',
        target: 'es2020',
        minify: true,
        define: {
          __SW_VERSION__: JSON.stringify(version),
          __PRECACHE__: JSON.stringify(files),
        },
      });

      writeFileSync(join(outDir, WORKER_FILE), code);
      this.info?.(`service worker: ${files.length} files precached, version ${version}`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // Only used in full-stack dev; the GH Pages build never calls /api.
      '/api': {
        target: process.env.PIGGY_API_URL || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
