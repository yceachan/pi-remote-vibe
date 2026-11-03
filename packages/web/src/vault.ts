export interface EncryptedKey {
  version: 1;
  iterations: number;
  salt: number[];
  iv: number[];
  ciphertext: number[];
}

const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const context = encoder.encode('pi-remote-vibe:ssh-private-key:v1');

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations}, material,
    {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}

export async function encryptPrivateKey(privateKey: string, passphrase: string): Promise<EncryptedKey> {
  if (passphrase.length < 12) throw new Error('解锁口令至少需要 12 个字符。');
  if (!/^-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/.test(privateKey.trim())) throw new Error('请输入 PEM / OpenSSH 格式的 SSH 私钥。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt, ITERATIONS);
  const bytes = encoder.encode(privateKey.trim());
  try {
    const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: context}, key, bytes);
    return {version: 1, iterations: ITERATIONS, salt: [...salt], iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)]};
  } finally { bytes.fill(0); }
}

export async function decryptPrivateKey(record: EncryptedKey, passphrase: string): Promise<string> {
  if (record.version !== 1 || record.iterations !== ITERATIONS || record.salt.length !== 16 || record.iv.length !== 12 || record.ciphertext.length < 16) throw new Error('本地密钥格式无效。');
  try {
    const key = await derive(passphrase, new Uint8Array(record.salt), record.iterations);
    const bytes = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: context}, key, new Uint8Array(record.ciphertext)));
    try { return new TextDecoder().decode(bytes); } finally { bytes.fill(0); }
  } catch { throw new Error('无法解锁：口令错误或密钥数据已损坏。'); }
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('pi-remote-vault', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本地密钥存储。请检查浏览器存储权限。'));
  });
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('keys', mode);
    const request = operation(tx.objectStore('keys'));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error('本地密钥存储操作失败。')); };
  });
}

export const loadEncryptedKey = () => transact<EncryptedKey | undefined>('readonly', (store) => store.get('phone'));
export const saveEncryptedKey = (record: EncryptedKey) => transact('readwrite', (store) => store.put(record, 'phone'));
export const deleteEncryptedKey = () => transact('readwrite', (store) => store.delete('phone'));

export function normalizeFingerprint(value: string): string {
  const fingerprint = value.trim();
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new Error('请输入由 PC 本机核实的 SHA256 SSH 主机指纹（43 位 Base64，无结尾 =）。');
  return fingerprint;
}
