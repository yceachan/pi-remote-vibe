import { readFileSync } from 'node:fs';

export interface RelayHost { id: string; name: string; port: number; sshUser: string }
export interface RelayUser { id: string; name: string; hostIds: string[]; enrollmentTokenHash?: string }
export interface RelayConfig {
  origin: string;
  rpId: string;
  listenHost: string;
  port: number;
  dataDir: string;
  staticDir?: string;
  sessionTtlMs?: number;
  hosts: RelayHost[];
  users: RelayUser[];
}
export function validateConfig(value: RelayConfig): RelayConfig {
  const origin = new URL(value.origin);
  if (origin.origin !== value.origin || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && origin.hostname === 'localhost'))) throw new Error('origin must be an HTTPS origin (http://localhost is allowed for development)');
  if (value.rpId !== origin.hostname) throw new Error('rpId must match the origin hostname');
  if (!['127.0.0.1', '::1'].includes(value.listenHost)) throw new Error('Relay must listen on loopback behind a TLS reverse proxy');
  if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error('Invalid listen port');
  if (!value.dataDir || !Array.isArray(value.hosts) || !Array.isArray(value.users)) throw new Error('dataDir, hosts and users are required');
  const ids = new Set<string>();
  for (const host of value.hosts) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(host.id) || ids.has(host.id)) throw new Error('Host IDs must be unique and URL-safe');
    if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('Invalid tunnel port');
    if (!host.name || !/^[a-zA-Z0-9_.-]{1,64}$/.test(host.sshUser)) throw new Error('Invalid host name or SSH username');
    ids.add(host.id);
  }
  const users = new Set<string>();
  for (const user of value.users) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(user.id) || users.has(user.id) || !user.name) throw new Error('Invalid or duplicate user');
    if (!Array.isArray(user.hostIds) || user.hostIds.some(id => !ids.has(id))) throw new Error('User references an unknown host');
    if (user.enrollmentTokenHash && !/^[a-f0-9]{64}$/.test(user.enrollmentTokenHash)) throw new Error('Enrollment token must be a SHA-256 hex hash');
    users.add(user.id);
  }
  return value;
}
export function loadConfig(path: string): RelayConfig {
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}
