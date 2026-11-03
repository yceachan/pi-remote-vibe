import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptPrivateKey, decryptPrivateKey, normalizeFingerprint} from './src/vault.js';

const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-not-a-real-secret\n-----END OPENSSH PRIVATE KEY-----';
test('vault decrypts only with the independent passphrase, with fresh salt and IV', async () => {
  const first = await encryptPrivateKey(privateKey, 'separate phone passphrase');
  const second = await encryptPrivateKey(privateKey, 'separate phone passphrase');
  assert.notDeepEqual(first.salt, second.salt);
  assert.notDeepEqual(first.iv, second.iv);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(await decryptPrivateKey(first, 'separate phone passphrase'), privateKey);
  assert.equal(JSON.stringify(first).includes('fixture'), false);
  await assert.rejects(decryptPrivateKey(first, 'wrong phone passphrase'), /无法解锁/);
  const tampered = structuredClone(first); tampered.ciphertext[0] ^= 1;
  await assert.rejects(decryptPrivateKey(tampered, 'separate phone passphrase'), /无法解锁/);
});
test('vault rejects weak setup passwords, unsupported records and unverified fingerprint formats', async () => {
  await assert.rejects(encryptPrivateKey(privateKey, 'short'), /12/);
  await assert.rejects(encryptPrivateKey('not a private key', 'a long enough password'), /私钥/);
  await assert.rejects(decryptPrivateKey({version: 1, iterations: 1, salt: [], iv: [], ciphertext: []}, 'whatever'), /格式无效/);
  assert.throws(() => normalizeFingerprint(''), /SHA256/);
  assert.throws(() => normalizeFingerprint('MD5:12:34'), /SHA256/);
  assert.throws(() => normalizeFingerprint(`SHA256:${'a'.repeat(43)}=`), /SHA256/);
  assert.equal(normalizeFingerprint(` SHA256:${'a'.repeat(43)} `), `SHA256:${'a'.repeat(43)}`);
});
