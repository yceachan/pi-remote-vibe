import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(cwd, process.argv[2] ?? '../web/public/ssh');
const go = process.env.GO_BINARY ?? 'go';
mkdirSync(target, { recursive: true });
execFileSync(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', resolve(target, 'ssh.wasm'), './cmd/wasm'], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, GOOS: 'js', GOARCH: 'wasm' },
});
const goroot = execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
copyFileSync(resolve(goroot, 'lib/wasm/wasm_exec.js'), resolve(target, 'wasm_exec.js'));
console.log(`Built browser SSH assets in ${target}`);
