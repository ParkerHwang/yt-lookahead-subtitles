import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SiwcManager,
  DYNAMIC_CLIENT_ID,
  OPENAI_API_RESOURCE,
  PLAN_USAGE_SCOPE,
} from '../siwc.mjs';
import {
  FORBIDDEN_RESPONSES_FIELDS,
  buildResponsesRequestBody,
  consumeResponsesSseStream,
  translateBatchWithChatGptPlan,
} from '../translator.mjs';

function makeTempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-test-'));
}

function makeRsaSignHelpers() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test-key-1';
  jwk.use = 'sig';
  jwk.alg = 'RS256';

  function signJwt(payload) {
    const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1' };
    const h = Buffer.from(JSON.stringify(header)).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
    return `${h}.${p}.${sig}`;
  }

  return { jwks: { keys: [jwk] }, signJwt };
}

function makeSseStream(events) {
  const text = events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('Sign in with ChatGPT (Open-Source Flow)', () => {
  it('generates stable RFC 9278 host ID, dynamic registration URL with 127.0.0.1 callback, and handles full token exchange + refresh + signout', async () => {
    const configDir = makeTempConfigDir();
    const { jwks, signJwt } = makeRsaSignHelpers();
    let refreshCallCount = 0;
    let revokeBody = null;
    let lastNonce = null;

    const mockFetch = async (url, init = {}) => {
      if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          }),
          { status: 200 }
        );
      }
      if (url === 'https://auth.openai.com/.well-known/jwks.json') {
        return new Response(JSON.stringify(jwks), { status: 200 });
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const params = new URLSearchParams(init.body);
        if (params.get('grant_type') === 'authorization_code') {
          assert.equal(params.get('client_id'), 'oaiapp_issued_1');
          assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
          assert.equal(params.get('resource'), OPENAI_API_RESOURCE);
          assert.ok(params.get('code_verifier'));
          const idToken = signJwt({
            iss: 'https://auth.openai.com',
            sub: 'user_abc123',
            aud: 'oaiapp_issued_1',
            email: 'viewer@example.com',
            name: 'Viewer',
            nonce: lastNonce,
            exp: Math.floor(Date.now() / 1000) + 3600,
          });
          return new Response(
            JSON.stringify({
              access_token: 'acc_tok_1',
              refresh_token: 'ref_tok_1',
              id_token: idToken,
              token_type: 'Bearer',
              expires_in: 3600,
              scope: `openid profile email offline_access resource.invoke ${PLAN_USAGE_SCOPE}`,
            }),
            { status: 200 }
          );
        }
        if (params.get('grant_type') === 'refresh_token') {
          refreshCallCount++;
          assert.equal(params.get('client_id'), 'oaiapp_issued_1');
          assert.equal(params.get('refresh_token'), 'ref_tok_1');
          assert.equal(params.get('scope'), null);
          return new Response(
            JSON.stringify({
              access_token: 'acc_tok_2',
              refresh_token: 'ref_tok_2',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { status: 200 }
          );
        }
      }
      if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') {
        revokeBody = new URLSearchParams(init.body);
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const siwc = new SiwcManager({ keyProvider: () => Buffer.alloc(32, 7), configDir, fetchImpl: mockFetch });
    const hostId1 = siwc.getOrCreateHostId();
    const hostId2 = siwc.getOrCreateHostId();
    assert.equal(hostId1, hostId2);
    assert.match(hostId1, /^urn:ietf:params:oauth:jwk-thumbprint:sha-256:/);

    const start = await siwc.startAuthorization({ port: 1455 });
    const authUrl = new URL(start.authUrl);
    lastNonce = authUrl.searchParams.get('nonce');
    assert.equal(authUrl.searchParams.get('client_id'), DYNAMIC_CLIENT_ID);
    assert.equal(authUrl.searchParams.get('agent_name_hint'), 'YouTube Lookahead Subtitles');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authUrl.searchParams.get('resource'), OPENAI_API_RESOURCE);
    assert.ok(authUrl.searchParams.get('scope').includes(PLAN_USAGE_SCOPE));

    const cbUrl = new URL('http://127.0.0.1:1455/auth/callback');
    cbUrl.searchParams.set('code', 'auth_code_xyz');
    cbUrl.searchParams.set('state', start.state);
    cbUrl.searchParams.set('client_id', 'oaiapp_issued_1');

    const account = await siwc.handleCallback(cbUrl);
    assert.equal(account.email, 'viewer@example.com');
    assert.equal(account.client_id, 'oaiapp_issued_1');
    assert.equal(account.planUsageEnabled, true);

    const credMode = fs.statSync(path.join(configDir, 'credentials.json')).mode & 0o777;
    assert.equal(credMode, 0o600);

    // Returning sign-in omits agent_name_hint and sends id_token_hint + issued client_id
    const returning = await siwc.startAuthorization({ port: 1455, accountKey: account.accountKey });
    const retUrl = new URL(returning.authUrl);
    assert.equal(retUrl.searchParams.get('client_id'), 'oaiapp_issued_1');
    assert.equal(retUrl.searchParams.get('agent_name_hint'), null);
    assert.ok(retUrl.searchParams.get('id_token_hint'));
    assert.equal(retUrl.searchParams.get('login_hint'), 'viewer@example.com');

    const addAnother = new URL((await siwc.startAuthorization({ port: 1455 })).authUrl);
    assert.equal(addAnother.searchParams.get('client_id'), DYNAMIC_CLIENT_ID);
    assert.equal(addAnother.searchParams.has('login_hint'), false);
    assert.equal(addAnother.searchParams.has('id_token_hint'), false);
    assert.equal(siwc.getPublicStatus().activeAccountKey, account.accountKey);

    // Serialized concurrent refresh should execute only one network request
    const [r1, r2] = await Promise.all([
      siwc.refreshAccessToken(account.accountKey),
      siwc.refreshAccessToken(account.accountKey),
    ]);
    assert.equal(refreshCallCount, 1);
    assert.equal(r1.access_token, 'acc_tok_2');
    assert.equal(r2.refresh_token, 'ref_tok_2');

    const signOutRes = await siwc.signOut(account.accountKey);
    assert.equal(signOutRes.remoteRevoked, true);
    assert.equal(revokeBody.get('token'), 'ref_tok_2');
    assert.equal(revokeBody.get('client_id'), 'oaiapp_issued_1');

    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('retains identity sign-in while blocking inference when chatgpt.tokens.use.direct is not granted', async () => {
    const configDir = makeTempConfigDir();
    const { jwks, signJwt } = makeRsaSignHelpers();
    let lastNonce = null;

    const mockFetch = async (url) => {
      if (url.includes('openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.openai.com',
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
            revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
            jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
          }),
          { status: 200 }
        );
      }
      if (url.includes('jwks.json')) return new Response(JSON.stringify(jwks), { status: 200 });
      if (url.includes('oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'id_only_tok',
            refresh_token: 'ref_1',
            id_token: signJwt({
              iss: 'https://auth.openai.com',
              sub: 'user_no_plan',
              aud: 'oaiapp_noplan',
              email: 'free@example.com',
              nonce: lastNonce,
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
            expires_in: 3600,
            scope: 'openid profile email offline_access',
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    };

    const siwc = new SiwcManager({ keyProvider: () => Buffer.alloc(32, 7), configDir, fetchImpl: mockFetch });
    const start = await siwc.startAuthorization({ port: 1455 });
    lastNonce = new URL(start.authUrl).searchParams.get('nonce');
    const account = await siwc.handleCallback(
      `http://127.0.0.1:1455/auth/callback?code=c1&state=${start.state}&client_id=oaiapp_noplan`
    );
    assert.equal(account.signedIn, true);
    assert.equal(account.planUsageEnabled, false);

    await assert.rejects(
      () => siwc.getValidAccessToken(account.accountKey),
      (err) => err.code === 'plan_usage_not_enabled'
    );

    fs.rmSync(configDir, { recursive: true, force: true });
  });
});

describe('Responses API Translator Compliance', () => {
  it('builds strictly compliant Responses payload without unsupported fields', () => {
    const body = buildResponsesRequestBody({
      model: 'gpt-6.2-sol',
      lines: [{ id: 'L0001', text: 'おはようございます。' }],
      contextLines: [{ id: 'L0000', text: 'こんにちは。' }],
    });
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(typeof body.instructions, 'string');
    assert.equal(body.input[0].role, 'user');
    assert.ok(!body.input.some((item) => item.role === 'system'));
    for (const forbidden of FORBIDDEN_RESPONSES_FIELDS) {
      assert.equal(Object.hasOwn(body, forbidden), false, `Forbidden field present: ${forbidden}`);
    }
  });

  it('streams SSE deltas through response.completed and rejects usage-limit or incomplete streams', async () => {
    const okStream = makeSseStream([
      { type: 'response.output_text.delta', delta: '{"translations":[{"id":"L0001",' },
      { type: 'response.output_text.delta', delta: '"ko":"좋은 아침이에요."}]}' },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
    ]);

    const parsed = await consumeResponsesSseStream(okStream);
    assert.match(parsed.outputText, /좋은 아침이에요/);

    const limitStream = makeSseStream([
      { type: 'response.output_text.delta', delta: '{"translations":' },
      {
        type: 'response.failed',
        response: {
          id: 'resp_2',
          error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached' },
        },
      },
    ]);
    await assert.rejects(
      () => consumeResponsesSseStream(limitStream),
      (err) => err.code === 'subscription_sharing_usage_limit_exceeded'
    );

    const truncatedStream = makeSseStream([
      { type: 'response.output_text.delta', delta: '{"translations":[]}' },
    ]);
    await assert.rejects(
      () => consumeResponsesSseStream(truncatedStream),
      (err) => err.code === 'stream_ended_without_completed'
    );
  });

  it('calls POST /v1/responses with OAuth access token and preserves exact line IDs', async () => {
    const fakeSiwc = {
      getValidAccessToken: async () => ({
        accountKey: 'oaiapp_1',
        accessToken: 'oauth_bearer_tok',
        selectedModel: 'gpt-6.2-sol',
      }),
    };
    let seenAuth = '';
    const mockFetch = async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      seenAuth = init.headers.Authorization;
      return new Response(
        makeSseStream([
          {
            type: 'response.output_text.delta',
            delta: JSON.stringify({
              translations: [
                { id: 'L0010', ko: '잠깐만 기다려 주세요.' },
                { id: 'L0011', ko: '네, 알겠습니다.' },
              ],
            }),
          },
          { type: 'response.completed', response: { id: 'resp_ok' } },
        ]),
        { status: 200, headers: { 'x-request-id': 'req_123' } }
      );
    };

    const res = await translateBatchWithChatGptPlan({
      siwc: fakeSiwc,
      lines: [
        { id: 'L0010', text: 'ちょっと待ってください。' },
        { id: 'L0011', text: 'はい、わかりました。' },
      ],
      fetchImpl: mockFetch,
    });
    assert.equal(seenAuth, 'Bearer oauth_bearer_tok');
    assert.equal(res.simulated, false);
    assert.deepEqual(res.translations, [
      { id: 'L0010', ko: '잠깐만 기다려 주세요.' },
      { id: 'L0011', ko: '네, 알겠습니다.' },
    ]);
  });
});
