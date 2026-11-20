import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompanionServer, EXTENSION_ORIGIN } from '../server.mjs';
import { SiwcManager } from '../siwc.mjs';

const clientHeaders = { Origin: EXTENSION_ORIGIN, 'X-YT-Client': '1', 'X-YT-Pair': 'test-pairing-code', 'Content-Type': 'application/json' };

describe('Companion request boundaries', () => {
  it('rejects untrusted hosts, origins, simple requests and direct auth navigation before account actions', async () => {
    let starts = 0;
    let statusReads = 0;
    const siwc = {
      getPublicStatus() { statusReads++; return { activeAccount: { email: 'test@example.com' } }; },
      async startAuthorization() { starts++; return { authUrl: 'https://auth.openai.com/test-only' }; },
    };
    const { server } = createCompanionServer({ siwc, pairingCode: 'test-pairing-code', whisperUrl: 'http://127.0.0.1:1' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const health = await (await fetch(`${base}/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(Object.hasOwn(health, 'auth'), false);
      assert.equal(statusReads, 0);
      for (const endpoint of ['/auth/start', '/api/auth/status', '/api/models', '/api/translate', '/api/auth/signout']) {
        assert.equal((await fetch(base + endpoint)).status, 403);
        for (const origin of ['https://example.com', 'http://127.0.0.1:9999', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
          assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { ...clientHeaders, Origin: origin }, body: '{}' })).status, 403);
        }
        assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { Origin: EXTENSION_ORIGIN, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      }
      assert.equal(starts, 0);
      assert.equal(statusReads, 0);
      const rebinding = await new Promise((resolve, reject) => {
        const request = http.get(base + '/health', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
      });
      assert.equal(rebinding, 403);
      const unpaired = await fetch(base + '/api/auth/status', { method: 'POST', headers: { ...clientHeaders, 'X-YT-Pair': '' }, body: '{}' });
      assert.equal(unpaired.status, 403);
      assert.equal((await unpaired.json()).error, 'pairing_required');
      const statusResponse = await fetch(base + '/api/auth/status', { method: 'POST', headers: clientHeaders, body: '{}' });
      assert.equal(statusResponse.status, 200);
      assert.equal(statusResponse.headers.get('Access-Control-Allow-Origin'), EXTENSION_ORIGIN);
      assert.equal((await statusResponse.json()).activeAccount.email, 'test@example.com');
      const auth = await fetch(base + '/auth/start', { method: 'POST', headers: clientHeaders, body: '{}' });
      assert.deepEqual(await auth.json(), { authUrl: 'https://auth.openai.com/test-only' });
      assert.equal(starts, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function makeRefreshFixture() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-refresh-test-'));
  const response = deferred();
  const started = deferred();
  const revoked = [];
  const siwc = new SiwcManager({ keyProvider: () => Buffer.alloc(32, 7), configDir, fetchImpl: async (url, init) => {
    if (url === 'https://auth.openai.com/token') {
      started.resolve();
      return response.promise;
    }
    if (url === 'https://auth.openai.com/revoke') {
      revoked.push(new URLSearchParams(init.body).get('token'));
      return new Response('', { status: 200 });
    }
    throw new Error(`Unexpected request ${url}`);
  } });
  siwc.oidcCache = { issuer: 'https://auth.openai.com', token_endpoint: 'https://auth.openai.com/token', revocation_endpoint: 'https://auth.openai.com/revoke' };
  siwc.saveStore({ activeAccountKey: 'account-a', accounts: {
    'account-a': { accountKey: 'account-a', client_id: 'account-a', access_token: 'old-access', refresh_token: 'old-refresh', credential_version: 'version-a', signed_out: false },
  } });
  return { siwc, started, response, revoked, configDir };
}

describe('Concurrent credential mutations', () => {
  it('keeps signout effective when an earlier refresh completes afterward', async () => {
    const fixture = makeRefreshFixture();
    const { siwc, started, response, revoked } = fixture;
    try {
      const refresh = siwc.refreshAccessToken('account-a');
      const rejectedRefresh = assert.rejects(refresh, error => error.code === 'reauth_required');
      await started.promise;
      await siwc.signOut('account-a');
      response.resolve(Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' }));
      await rejectedRefresh;
      const store = siwc.loadStore();
      assert.equal(store.accounts['account-a'].signed_out, true);
      assert.equal(store.accounts['account-a'].access_token, '');
      assert.equal(store.activeAccountKey, null);
      assert.deepEqual(revoked, ['old-refresh', 'new-refresh']);
    } finally { fs.rmSync(fixture.configDir, { recursive: true, force: true }); }
  });

  it('preserves another account and model choice created during refresh', async () => {
    const fixture = makeRefreshFixture();
    const { siwc, started, response } = fixture;
    try {
      const refresh = siwc.refreshAccessToken('account-a');
      await started.promise;
      const store = siwc.loadStore();
      store.accounts['account-b'] = { accountKey: 'account-b', access_token: 'b-access' };
      store.activeAccountKey = 'account-b';
      store.accounts['account-a'].selected_model = 'chosen-during-refresh';
      siwc.saveStore(store);
      response.resolve(Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' }));
      await refresh;
      const saved = siwc.loadStore();
      assert.equal(saved.activeAccountKey, 'account-b');
      assert.equal(saved.accounts['account-b'].access_token, 'b-access');
      assert.equal(saved.accounts['account-a'].selected_model, 'chosen-during-refresh');
      assert.equal(saved.accounts['account-a'].access_token, 'new-access');
    } finally { fs.rmSync(fixture.configDir, { recursive: true, force: true }); }
  });
});
