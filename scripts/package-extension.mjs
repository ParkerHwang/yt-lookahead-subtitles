#!/usr/bin/env node
/** Build a deterministic Chrome Web Store ZIP using only Node.js built-ins. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const extension = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
delete manifest.key;
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0
  ? path.resolve(process.argv[outputIndex + 1] || '')
  : path.join(root, 'dist', `lookahead-subtitles-${manifest.version}.zip`);
if (outputIndex >= 0 && (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))) {
  throw new Error('--output requires a file path');
}

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.')) return [];
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in extension package: ${entry.name}`);
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(absolute) : [absolute];
  });
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const entries = filesIn(extension).map(absolute => {
  const name = path.relative(extension, absolute).split(path.sep).join('/');
  return { name, bytes: name === 'manifest.json'
    ? Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
    : fs.readFileSync(absolute) };
}).sort((left, right) => left.name.localeCompare(right.name, 'en'));

const localParts = [];
const centralParts = [];
let offset = 0;
for (const { name, bytes } of entries) {
  const filename = Buffer.from(name, 'utf8');
  const checksum = crc32(bytes);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12); // 1980-01-01, fixed for reproducible output.
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(offset, 42);
  localParts.push(header, filename, bytes);
  centralParts.push(central, filename);
  offset += header.length + filename.length + bytes.length;
}
const directory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...localParts, directory, end]);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, zip);
console.log(JSON.stringify({ output, files: entries.length, bytes: zip.length,
  sha256: crypto.createHash('sha256').update(zip).digest('hex'), developmentKeyIncluded: false }, null, 2));
