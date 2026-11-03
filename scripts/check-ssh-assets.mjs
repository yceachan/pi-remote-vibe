import { accessSync } from 'node:fs';
for (const file of ['ssh.wasm', 'wasm_exec.js']) {
  try { accessSync(new URL(`../packages/web/public/ssh/${file}`, import.meta.url)); }
  catch { console.error('Missing browser SSH assets. Run pnpm build:ssh before pnpm build.'); process.exit(1); }
}
