import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FORMAT = 'lookahead-credentials';
const AAD = Buffer.from(`${FORMAT}:1`, 'utf8');

function regularFile(filePath) {
  try {
    if (!fs.lstatSync(filePath).isFile()) throw new Error('Credential storage must be a regular file');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Credential storage directory is invalid');
  }
  fs.chmodSync(directory, 0o700);
}

export function createMacKeyProvider(configDir) {
  const source = fileURLToPath(new URL('./keychain-key.c', import.meta.url));
  const directory = path.join(configDir, 'keychain-helper');
  const binary = path.join(directory, 'keychain-key');
  const marker = path.join(directory, 'source.sha256');
  return ({ create }) => {
    if (process.platform !== 'darwin') throw new Error('Encrypted account storage requires macOS Keychain');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    privateDirectory(configDir);
    privateDirectory(directory);
    if (!regularFile(binary) || !regularFile(marker) || fs.readFileSync(marker, 'utf8') !== digest) {
      const temporary = `${binary}.${crypto.randomUUID()}`;
      try {
        execFileSync('/usr/bin/xcrun', ['clang', '-O2', source, '-framework', 'Security',
          '-framework', 'CoreFoundation', '-o', temporary], { stdio: 'pipe', timeout: 60_000 });
        fs.chmodSync(temporary, 0o700);
        fs.renameSync(temporary, binary);
        fs.writeFileSync(marker, digest, { mode: 0o600 });
      } catch {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        throw new Error('Keychain helper could not be built. Install Xcode Command Line Tools and try again.');
      }
    }
    const account = crypto.createHash('sha256').update(path.resolve(configDir)).digest('hex');
    try {
      const key = execFileSync(binary, [create ? 'create' : 'get',
        'lookahead-subtitles.credential-key.v1', account], { stdio: 'pipe', timeout: 90_000 });
      if (key.length !== 32) throw new Error('Invalid key size');
      return key;
    } catch {
      throw new Error('Credential encryption key is unavailable. Unlock the macOS login Keychain and allow this helper access.');
    }
  };
}

function encryptionKey(provider, create) {
  const value = provider({ create });
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error('Credential encryption key has an invalid size');
  return Buffer.from(value);
}

export class CredentialVault {
  constructor(filePath, { keyProvider } = {}) {
    this.filePath = filePath;
    this.keyProvider = keyProvider || createMacKeyProvider(path.dirname(filePath));
  }

  read() {
    if (!regularFile(this.filePath)) return null;
    let envelope;
    try { envelope = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); }
    catch { throw new Error('Credential storage is unreadable. The original file has been preserved.'); }
    if (envelope?.format !== FORMAT || envelope.version !== 1) {
      throw new Error('Unsupported or legacy plaintext credential storage. Choose a new configuration directory and sign in again.');
    }
    const key = encryptionKey(this.keyProvider, false);
    try {
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted envelope');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const clear = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const store = JSON.parse(clear.toString('utf8'));
      if (!store || typeof store !== 'object' || !store.accounts || Array.isArray(store.accounts)) throw new Error('Invalid account store');
      return store;
    } catch {
      throw new Error('Credential storage authentication failed. The original file has been preserved.');
    } finally { key.fill(0); }
  }

  write(store) {
    const exists = regularFile(this.filePath);
    if (exists) this.read();
    privateDirectory(path.dirname(this.filePath));
    const key = encryptionKey(this.keyProvider, !exists);
    const iv = crypto.randomBytes(12);
    let envelope;
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(store), 'utf8'), cipher.final()]);
      envelope = { format: FORMAT, version: 1, iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    } finally { key.fill(0); }
    const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(envelope) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw error;
    }
  }
}
