#!/usr/bin/env node
import { connect } from 'node:net';

// This program is suitable for an authorized_keys forced command. It accepts no
// remote command arguments, opens no shell, and never owns the Pi worker.
const socketPath = process.env.PI_REMOTE_SOCKET ?? process.argv[2];
if (!socketPath || !socketPath.startsWith('/')) {
  process.stderr.write('Set PI_REMOTE_SOCKET or pass an absolute Unix socket path.\n');
  process.exitCode = 1;
} else if (process.env.SSH_TTY) {
  process.stderr.write('PTY sessions are not supported; use a non-PTY exec channel.\n');
  process.exitCode = 1;
} else {
  const socket = connect(socketPath);
  socket.on('connect', () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
  socket.on('error', error => { process.stderr.write(`Cannot connect to session manager: ${error.message}\n`); process.exitCode = 1; process.stdin.destroy(); });
  socket.on('close', () => { process.stdin.destroy(); });
  process.stdout.on('error', () => socket.destroy());
  process.on('SIGTERM', () => socket.destroy());
  process.on('SIGINT', () => socket.destroy());
}
