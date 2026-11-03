import { randomBytes, createHash } from 'node:crypto';
const token = randomBytes(32).toString('base64url');
console.log('One-use enrollment token (deliver to your device over a trusted channel):');
console.log(token);
console.log('\nPlace only this hash in the relay user enrollmentTokenHash:');
console.log(createHash('sha256').update(token).digest('hex'));
