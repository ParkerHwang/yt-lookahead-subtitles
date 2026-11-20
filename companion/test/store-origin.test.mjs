import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompanionServer } from '../server.mjs';

test('the published ID grants only the paired extension access', async () => {
  const storeId = 'd'.repeat(32);
  const options = { storeExtensionId: storeId, pairingCode: 'test-only', siwc: { getPublicStatus: () => ({ accounts: [] }) } };
  for (const invalid of ['*', 'https://example.com', storeId + '.example', 'z'.repeat(32)]) {
    assert.throws(() => createCompanionServer({ ...options, storeExtensionId: invalid }), /item ID/);
  }
  const {server} = createCompanionServer(options);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/api/auth/status';
    const post = (id, pair) => fetch(url, { method: 'POST', body: '{}', headers: {
      Origin:'chrome-extension://' + id, 'X-YT-Client':'1', 'X-YT-Pair':pair, 'Content-Type':'application/json',
    } });
    assert.equal((await post(storeId, 'wrong')).status, 403);
    assert.equal((await post('f'.repeat(32), 'test-only')).status, 403);
    const allowed = await post(storeId, 'test-only');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'chrome-extension://' + storeId);
  } finally {
    await new Promise(done => server.close(done));
  }
});
