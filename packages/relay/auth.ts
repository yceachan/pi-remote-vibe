import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { RelayConfig, RelayUser } from './config.ts';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
interface Credential { id: string; userId: string; publicKey: string; counter: number; transports?: string[] }
interface State { credentials: Credential[]; usedInvites: string[] }
interface Challenge { challenge: string; kind: 'register'|'login'; expires: number; userId?: string; invite?: string }
export interface LoginSession { userId: string; expires: number }
export class AuthError extends Error { constructor(public status: number, message: string) { super(message); } }
export const webAuthn = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

export class AuthService {
  private state: State;
  private challenges = new Map<string, Challenge>();
  private sessions = new Map<string, LoginSession>();
  private statePath: string;
  constructor(private config: RelayConfig, private api = webAuthn) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.statePath = join(config.dataDir, 'passkeys.json');
    try { this.state = JSON.parse(readFileSync(this.statePath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = { credentials: [], usedInvites: [] }; }
  }
  private save() {
    writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(`${this.statePath}.tmp`, this.statePath);
  }
  private challenge(value: Omit<Challenge, 'expires'>) {
    for (const [key, entry] of this.challenges) if (entry.expires <= Date.now()) this.challenges.delete(key);
    if (this.challenges.size >= 1000) throw new AuthError(429, 'Too many authentication attempts');
    const token = randomToken();
    this.challenges.set(hashToken(token), { ...value, expires: Date.now() + 120_000 });
    return token;
  }
  private consume(token: string | undefined, kind: Challenge['kind']) {
    const key = hashToken(token ?? '');
    const entry = this.challenges.get(key);
    this.challenges.delete(key);
    if (!entry || entry.kind !== kind || entry.expires <= Date.now()) throw new AuthError(401, 'Authentication challenge expired; try again');
    return entry;
  }
  async registerOptions(token: unknown) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) throw new AuthError(403, 'Invalid enrollment token');
    const digest = hashToken(token);
    const user = this.config.users.find(u => u.enrollmentTokenHash && timingSafeEqual(Buffer.from(u.enrollmentTokenHash, 'hex'), Buffer.from(digest, 'hex')));
    if (!user || this.state.usedInvites.includes(digest)) throw new AuthError(403, 'Enrollment token invalid or already used');
    const options = await this.api.generateRegistrationOptions({
      rpName: 'Pi Remote Vibe', rpID: this.config.rpId, userName: user.name,
      userID: new TextEncoder().encode(user.id), attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: this.state.credentials.filter(c => c.userId === user.id).map(c => ({ id: c.id, transports: c.transports })),
    });
    return { options, token: this.challenge({ challenge: options.challenge, kind: 'register', userId: user.id, invite: digest }) };
  }
  async registerVerify(token: string | undefined, credential: RegistrationResponseJSON) {
    const challenge = this.consume(token, 'register');
    const verification = await this.api.verifyRegistrationResponse({ response: credential, expectedChallenge: challenge.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpId, requireUserVerification: true });
    if (!verification.verified || !verification.registrationInfo) throw new AuthError(401, 'Passkey verification failed');
    if (this.state.usedInvites.includes(challenge.invite!)) throw new AuthError(403, 'Enrollment token already used');
    const { credential: key } = verification.registrationInfo;
    if (this.state.credentials.some(c => c.id === key.id)) throw new AuthError(409, 'Passkey already registered');
    this.state.credentials.push({ id: key.id, userId: challenge.userId!, publicKey: Buffer.from(key.publicKey).toString('base64url'), counter: key.counter, transports: key.transports });
    this.state.usedInvites.push(challenge.invite!);
    this.save();
    return this.login(challenge.userId!);
  }
  async loginOptions() {
    const options = await this.api.generateAuthenticationOptions({ rpID: this.config.rpId, userVerification: 'required' });
    return { options, token: this.challenge({ challenge: options.challenge, kind: 'login' }) };
  }
  async loginVerify(token: string | undefined, credential: AuthenticationResponseJSON) {
    const challenge = this.consume(token, 'login');
    const key = this.state.credentials.find(c => c.id === credential?.id);
    if (!key || !this.user(key.userId)) throw new AuthError(401, 'Unknown passkey');
    const verification = await this.api.verifyAuthenticationResponse({ response: credential, expectedChallenge: challenge.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpId, requireUserVerification: true, credential: { ...key, publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')) } });
    if (!verification.verified) throw new AuthError(401, 'Passkey verification failed');
    // Concurrent assertions must not roll a signature counter backwards.
    const nextCounter = verification.authenticationInfo.newCounter;
    if ((nextCounter > 0 || key.counter > 0) && nextCounter <= key.counter) throw new AuthError(401, 'Stale passkey assertion');
    key.counter = verification.authenticationInfo.newCounter;
    this.save();
    return this.login(key.userId);
  }
  private login(userId: string) {
    for (const [key, entry] of this.sessions) if (entry.expires <= Date.now()) this.sessions.delete(key);
    if (this.sessions.size >= 1000) throw new AuthError(429, 'Too many sessions');
    const token = randomToken();
    this.sessions.set(hashToken(token), { userId, expires: Date.now() + (this.config.sessionTtlMs ?? 12 * 3600_000) });
    return token;
  }
  session(token: string | undefined): LoginSession | undefined {
    const key = hashToken(token ?? '');
    const session = this.sessions.get(key);
    if (!session || session.expires <= Date.now() || !this.user(session.userId)) { this.sessions.delete(key); return undefined; }
    return session;
  }
  user(id: string): RelayUser | undefined { return this.config.users.find(u => u.id === id); }
  logout(token: string | undefined) { this.sessions.delete(hashToken(token ?? '')); }
}
