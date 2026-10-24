// Bundle the two functions with esbuild. Workspace packages are TypeScript sources, so they are
// bundled in; every third-party dependency stays external and is resolved from node_modules at
// runtime (they are listed in package.json so Vercel's tracer ships them).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@cooks/') && d !== 'cooks-mcp');
await build({
  entryPoints: { server: 'src/server.ts', tick: 'src/tick.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  external: [...external, 'pg-native', '@electric-sql/pglite', 'bun:*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
