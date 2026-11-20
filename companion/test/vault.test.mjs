import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CredentialVault } from '../vault.mjs';

function fixture(t, keyProvider) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookahead-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'credentials.json');
  const key = crypto.randomBytes(32);
  const calls = [];
  const provider = keyProvider || (({ create }) => { calls.push(create); return key; });
  return { dir, file, key, calls, vault: new CredentialVault(file, { keyProvider: provider }) };
}
const accountStore = { activeAccountKey: 'fixture-account', accounts: {
  'fixture-account': { email: 'fixture@example.test', access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token' },
} };

test('encrypts account profile and tokens with a fresh authenticated nonce on each atomic save', t => {
  const { vault, file, key, calls, dir } = fixture(t);
  assert.equal(vault.read(), null);
  assert.deepEqual(calls, []);
  vault.write(accountStore);
  const first = fs.readFileSync(file, 'utf8');
  for (const secret of ['fixture-access-token', 'fixture-refresh-token', 'fixture@example.test']) assert.equal(first.includes(secret), false);
  assert.deepEqual(vault.read(), accountStore);
  vault.write(accountStore);
  const second = fs.readFileSync(file, 'utf8');
  assert.notEqual(JSON.parse(first).iv, JSON.parse(second).iv);
  assert.deepEqual(vault.read(), accountStore);
  assert.deepEqual(calls, [true, false, false, false, false]);
  assert.ok(key.some(byte => byte !== 0), 'providers retain ownership of their key buffer');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), ['credentials.json']);
});

test('rejects corrupted ciphertext and wrong keys and preserves the encrypted original', t => {
  const { vault, file } = fixture(t);
  vault.write(accountStore);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bytes = Buffer.from(envelope.ciphertext, 'base64'); bytes[0] ^= 1;
  envelope.ciphertext = bytes.toString('base64');
  fs.writeFileSync(file, JSON.stringify(envelope));
  const corrupted = fs.readFileSync(file, 'utf8');
  assert.throws(() => vault.read(), /authentication failed/);
  assert.throws(() => vault.write(accountStore), /authentication failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupted);
  const wrong = new CredentialVault(file, { keyProvider: () => crypto.randomBytes(32) });
  assert.throws(() => wrong.read(), /authentication failed/);
});

test('existing store cannot create a replacement Keychain key when key access fails', t => {
  const { vault, file } = fixture(t);
  vault.write(accountStore);
  const original = fs.readFileSync(file, 'utf8');
  const locked = new CredentialVault(file, { keyProvider: ({ create }) => {
    assert.equal(create, false); throw new Error('Keychain locked');
  } });
  assert.throws(() => locked.read(), /Keychain locked/);
  assert.throws(() => locked.write(accountStore), /Keychain locked/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('preserves legacy plaintext or malformed storage and rejects symlink targets', t => {
  const { vault, file, dir } = fixture(t, () => { throw new Error('Keychain must not be touched'); });
  fs.writeFileSync(file, JSON.stringify(accountStore));
  const legacy = fs.readFileSync(file, 'utf8');
  assert.throws(() => vault.read(), /legacy plaintext/);
  assert.throws(() => vault.write(accountStore), /legacy plaintext/);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  fs.writeFileSync(file, '{bad json');
  assert.throws(() => vault.write(accountStore), /unreadable/);
  const link = path.join(dir, 'linked.json'); fs.symlinkSync(file, link);
  assert.throws(() => new CredentialVault(link).read(), /regular file/);
});
