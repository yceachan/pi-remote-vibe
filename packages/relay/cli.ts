import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { createRelay } from './server.ts';
const configPath = process.argv[2];
if (!configPath) { console.error('Usage: pnpm relay <relay-config.json>'); process.exit(1); }
const config = loadConfig(resolve(configPath));
const relay = createRelay(config);
relay.server.listen(config.port, config.listenHost, () => console.log(`Pi relay listening on ${config.listenHost}:${config.port}; public origin ${config.origin}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
