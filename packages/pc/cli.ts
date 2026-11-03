#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionManager, type ManagerOptions } from './manager.js';

const configFile = process.argv[2];
if (!configFile) {
  process.stderr.write('Usage: node --import tsx packages/pc/cli.ts /absolute/path/to/pc-config.json\n');
  process.exitCode = 1;
} else {
  const config = JSON.parse(readFileSync(resolve(configFile), 'utf8')) as ManagerOptions;
  if (!config.dataDir || !config.socketPath || !Array.isArray(config.projects)) throw new Error('Config requires dataDir, socketPath, and projects');
  const manager = new SessionManager({ ...config, diagnostic: (sessionId, message) => process.stderr.write(`[pi ${sessionId}] ${message}`) });
  await manager.start();
  process.stderr.write(`Pi session manager listening on ${config.socketPath}\n`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await manager.stop(); };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
}
