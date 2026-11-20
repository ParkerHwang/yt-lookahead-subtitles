/** No-account smoke test for the ordinary Chrome window telemetry path. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentInteractiveExtension, launchInteractiveBrowser, sanitizeInteractiveSample } from './interactive-check.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-interactive-smoke-'));
const extensionDir = path.join(runDir, 'extension');
const videoId = '2LSJpvd9MwI';
const pairingCode = crypto.randomBytes(32).toString('hex');
const origin = 'chrome-extension://biahghfnkaenlchallpkncbmomlickfd';
const samples = [];
let inferenceAttempts = 0;
const server = http.createServer(async (req, res) => {
  const headers = { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':origin,
    'Access-Control-Allow-Headers':'content-type,x-yt-client,x-yt-pair', 'Access-Control-Allow-Methods':'POST,GET,OPTIONS' };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
  let raw=''; for await (const part of req) raw += part;
  let result = {};
  if (req.url === '/health') result = { ok:true, whisper:{ok:false} };
  else if (req.headers.origin !== origin || req.headers['x-yt-pair'] !== pairingCode) { res.writeHead(403,headers);res.end('{}');return; }
  else if (req.url === '/test/telemetry') { samples.push(sanitizeInteractiveSample(JSON.parse(raw),videoId)); result = { stopped:samples.length>=3 }; }
  else if (req.url === '/api/auth/status') result = { activeAccount:null, accounts:[] };
  else { inferenceAttempts++; res.writeHead(403,headers);res.end('{"error":"smoke_has_no_inference"}');return; }
  res.writeHead(200,headers);res.end(JSON.stringify(result));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const proxyUrl = `http://127.0.0.1:${server.address().port}`;
fs.cpSync(path.join(root,'extension'),extensionDir,{recursive:true});
const transport = path.join(extensionDir,'companion-client.js');
fs.writeFileSync(transport,fs.readFileSync(transport,'utf8').replaceAll('http://127.0.0.1:17864',proxyUrl));
instrumentInteractiveExtension({extensionDir,proxyUrl,pairingCode,videoId});
let browser;
try {
  browser=launchInteractiveBrowser({profileDir:path.join(runDir,'profile'),extensionDir,url:`https://www.youtube.com/watch?v=${videoId}&t=225s`});
  const deadline=Date.now()+45000;
  while(samples.length<3&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,500));
  assert.ok(samples.length>=3,'isolated background and content telemetry should reach the local service');
  assert.equal(inferenceAttempts,0);
  console.log(JSON.stringify({pass:true,samples:samples.length,inferenceAttempts,channel:samples.at(-1).nativePlayback.channel,mode:'ordinary_window_no_debugging',runDir}));
} finally {
  browser?.kill('SIGTERM');
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(runDir,'results.json'),JSON.stringify({samples,inferenceAttempts},null,2));
}
