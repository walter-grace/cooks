#!/usr/bin/env node
import('../dist/stdio.js').catch(async () => {
  // Development fallback: run the TypeScript source through tsx.
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('../src/stdio.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', path], { stdio: 'inherit', env: process.env });
  child.on('exit', (code) => process.exit(code ?? 0));
});
