import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialVault } from './vault.mjs';

export const OIDC_ISSUER = 'https://auth.openai.com';
export const OIDC_DISCOVERY_URL = `${OIDC_ISSUER}/.well-known/openid-configuration`;
export const OPENAI_API_RESOURCE = 'https://api.openai.com/v1';
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const AGENT_NAME_HINT = 'YouTube Lookahead Subtitles';
export const REQUESTED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
];
export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';

const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function defaultConfigDir() {
  return process.env.YT_SUB_CONFIG_DIR || path.join(os.homedir(), '.config', 'lookahead-subtitles');
}

function writeJsonAtomic0600(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Compute RFC 9278 JWK Thumbprint URI (urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>)
 * for an EC P-256 public JWK.
 */
export function computeEcJwkThumbprintUri(jwk) {
  // Lexicographical member order per RFC 7638 Section 3.2: crv, kty, x, y
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest();
  return `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${base64UrlEncode(digest)}`;
}

export function generatePkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(
    crypto.createHash('sha256').update(codeVerifier, 'ascii').digest()
  );
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

export function decodeJwtParts(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }
  const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  const signature = base64UrlDecode(parts[2]);
  return {
    header,
    payload,
    signature,
    signingInput: `${parts[0]}.${parts[1]}`,
  };
}

export async function verifyIdTokenWithJwks(idToken, { jwks, expectedIssuer, expectedAudience, expectedNonce, nowSec }) {
  const { header, payload, signature, signingInput } = decodeJwtParts(idToken);
  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported ID token alg: ${header.alg}`);
  }

  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const matchingKey = keys.find((k) => (!header.kid || k.kid === header.kid) && k.kty === 'RSA');
  if (!matchingKey) {
    const err = new Error(`No matching JWK found for kid=${header.kid || 'none'}`);
    err.code = 'jwks_kid_not_found';
    throw err;
  }

  const publicKey = crypto.createPublicKey({ key: matchingKey, format: 'jwk' });
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(signingInput, 'ascii'),
    publicKey,
    signature
  );
  if (!verified) {
    throw new Error('ID token signature verification failed');
  }

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (payload.iss !== expectedIssuer) {
    throw new Error(`Invalid ID token issuer: ${payload.iss}`);
  }

  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(expectedAudience)) {
    throw new Error(`ID token audience mismatch`);
  }

  if (typeof payload.exp !== 'number' || payload.exp <= now - 30) {
    throw new Error('ID token is expired');
  }

  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new Error('ID token nonce mismatch');
  }

  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('ID token missing sub claim');
  }

  return payload;
}

export class SiwcManager {
  constructor(options = {}) {
    this.configDir = options.configDir || defaultConfigDir();
    this.hostPath = path.join(this.configDir, 'host.json');
    this.credentialsPath = path.join(this.configDir, 'credentials.json');
    this.vault = options.vault || new CredentialVault(this.credentialsPath, { keyProvider: options.keyProvider });
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.pendingTransactions = new Map();
    this.refreshLocks = new Map();
    this.oidcCache = null;
    this.jwksCache = null;
    this.jwksFetchedAt = 0;
  }

  getOrCreateHostId() {
    const existing = readJsonSafe(this.hostPath);
    if (existing?.ext_agent_host_id) {
      return existing.ext_agent_host_id;
    }
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const hostId = computeEcJwkThumbprintUri(publicJwk);
    writeJsonAtomic0600(this.hostPath, {
      ext_agent_host_id: hostId,
      public_jwk: publicJwk,
      created_at: new Date().toISOString(),
    });
    return hostId;
  }

  loadStore() {
    const raw = this.vault.read();
    if (raw) return raw;
    return {
      activeAccountKey: null,
      accounts: {},
    };
  }

  saveStore(store) {
    this.vault.write(store);
  }

  async getOidcConfig() {
    if (this.oidcCache) return this.oidcCache;
    const resp = await this.fetchImpl(OIDC_DISCOVERY_URL);
    if (!resp.ok) {
      throw new Error(`Failed OIDC discovery: HTTP ${resp.status}`);
    }
    const doc = await resp.json();
    if (doc.issuer !== OIDC_ISSUER) {
      throw new Error(`Unexpected OIDC issuer: ${doc.issuer}`);
    }
    this.oidcCache = doc;
    return doc;
  }

  async getJwks(forceRefresh = false) {
    const oidc = await this.getOidcConfig();
    if (!forceRefresh && this.jwksCache && Date.now() - this.jwksFetchedAt < 3600_000) {
      return this.jwksCache;
    }
    const resp = await this.fetchImpl(oidc.jwks_uri);
    if (!resp.ok) {
      throw new Error(`Failed JWKS fetch: HTTP ${resp.status}`);
    }
    const jwks = await resp.json();
    this.jwksCache = jwks;
    this.jwksFetchedAt = Date.now();
    return jwks;
  }

  async validateIdToken(idToken, { expectedAudience, expectedNonce }) {
    const oidc = await this.getOidcConfig();
    let jwks = await this.getJwks(false);
    try {
      return await verifyIdTokenWithJwks(idToken, {
        jwks,
        expectedIssuer: oidc.issuer,
        expectedAudience,
        expectedNonce,
      });
    } catch (err) {
      if (err.code === 'jwks_kid_not_found') {
        jwks = await this.getJwks(true);
        return await verifyIdTokenWithJwks(idToken, {
          jwks,
          expectedIssuer: oidc.issuer,
          expectedAudience,
          expectedNonce,
        });
      }
      throw err;
    }
  }

  /**
   * Build an official OpenAI open-source Sign in with ChatGPT authorization URL.
   * Strictly binds loopback callback to 127.0.0.1:<port>/auth/callback (never localhost).
   */
  async startAuthorization({ port = 17864, accountKey = null, forceReconsent = false } = {}) {
    const oidc = await this.getOidcConfig();
    const extAgentHostId = this.getOrCreateHostId();
    const store = this.loadStore();
    const existing = accountKey ? store.accounts[accountKey] : null;

    const state = base64UrlEncode(crypto.randomBytes(32));
    const nonce = base64UrlEncode(crypto.randomBytes(32));
    const pkce = generatePkcePair();
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;

    const isReturning = Boolean(existing?.client_id && existing.client_id !== DYNAMIC_CLIENT_ID);

    const params = new URLSearchParams({
      client_id: isReturning ? existing.client_id : DYNAMIC_CLIENT_ID,
      ext_agent_host_id: extAgentHostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: REQUESTED_SCOPES.join(' '),
      resource: OPENAI_API_RESOURCE,
      state,
      nonce,
      code_challenge_method: pkce.codeChallengeMethod,
      code_challenge: pkce.codeChallenge,
    });

    if (isReturning) {
      // Omit agent_name_hint on reauthorization with an issued client ID
      if (existing.id_token) {
        params.set('id_token_hint', existing.id_token);
      }
      if (existing.email) {
        params.set('login_hint', existing.email);
      }
    } else {
      params.set('agent_name_hint', AGENT_NAME_HINT);
    }

    if (forceReconsent) {
      params.set('prompt', 'consent');
    }

    const authUrl = `${oidc.authorization_endpoint}?${params.toString()}`;

    // Prune expired pending transactions (>10 min)
    const now = Date.now();
    for (const [k, tx] of this.pendingTransactions) {
      if (now - tx.createdAt > 10 * 60_000) {
        this.pendingTransactions.delete(k);
      }
    }

    this.pendingTransactions.set(state, {
      state,
      nonce,
      codeVerifier: pkce.codeVerifier,
      redirectUri,
      resource: OPENAI_API_RESOURCE,
      extAgentHostId,
      isNewRegistration: !isReturning,
      expectedClientId: isReturning ? existing.client_id : null,
      expectedSubject: isReturning ? existing.subject : null,
      accountKey: isReturning ? existing.accountKey : null,
      createdAt: now,
    });

    return {
      authUrl,
      state,
      redirectUri,
      isNewRegistration: !isReturning,
    };
  }

  /**
   * Handle the loopback callback from OpenAI OAuth, exchange the authorization code,
   * verify the ID token and granted scopes, and persist protected local credentials.
   */
  async handleCallback(callbackUrl) {
    const url = callbackUrl instanceof URL ? callbackUrl : new URL(callbackUrl);
    const state = url.searchParams.get('state');
    const tx = state ? this.pendingTransactions.get(state) : null;
    if (state) this.pendingTransactions.delete(state);

    if (!tx || Date.now() - tx.createdAt > 10 * 60_000) {
      const err = new Error('Sign-in state missing, expired, or already consumed.');
      err.code = 'invalid_state';
      throw err;
    }

    if (`${url.origin}${url.pathname}` !== tx.redirectUri) {
      throw Object.assign(new Error('Authorization callback URI mismatch.'), { code: 'invalid_callback_uri' });
    }

    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      const err = new Error(url.searchParams.get('error_description') || `OAuth error: ${oauthError}`);
      err.code = oauthError;
      throw err;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      const err = new Error('Authorization callback missing code.');
      err.code = 'missing_code';
      throw err;
    }

    const returnedClientId = url.searchParams.get('client_id');
    let issuedClientId;
    if (tx.isNewRegistration) {
      if (!returnedClientId || returnedClientId === DYNAMIC_CLIENT_ID) {
        const err = new Error('New registration callback did not include an issued client_id.');
        err.code = 'incomplete_registration';
        throw err;
      }
      issuedClientId = returnedClientId;
    } else {
      if (returnedClientId && returnedClientId !== tx.expectedClientId) {
        const err = new Error('Callback returned a mismatched client_id.');
        err.code = 'mismatched_client_id';
        throw err;
      }
      issuedClientId = tx.expectedClientId;
    }

    const oidc = await this.getOidcConfig();
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: issuedClientId,
      code,
      code_verifier: tx.codeVerifier,
      redirect_uri: tx.redirectUri,
      resource: tx.resource,
    });

    const tokenResp = await this.fetchImpl(oidc.token_endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: tokenBody.toString(),
    });

    const tokenData = await tokenResp.json().catch(() => ({}));
    if (!tokenResp.ok) {
      const err = new Error(tokenData.error_description || tokenData.error || `Token exchange HTTP ${tokenResp.status}`);
      err.code = tokenData.error || 'token_exchange_failed';
      throw err;
    }

    if (!tokenData.id_token || !tokenData.access_token) {
      throw new Error('Token response missing id_token or access_token');
    }

    const idClaims = await this.validateIdToken(tokenData.id_token, {
      expectedAudience: issuedClientId,
      expectedNonce: tx.nonce,
    });

    if (tx.expectedSubject && idClaims.sub !== tx.expectedSubject) {
      const err = new Error('Authenticated ChatGPT account does not match the selected saved registration.');
      err.code = 'subject_mismatch';
      throw err;
    }

    const grantedScopes = String(tokenData.scope || '')
      .split(/\s+/)
      .filter(Boolean);
    const planUsageEnabled = grantedScopes.includes(PLAN_USAGE_SCOPE);

    const store = this.loadStore();
    const accountKey = issuedClientId;
    const prevRecord = store.accounts[accountKey] || {};
    const nowIso = new Date().toISOString();
    const sameEmailCount = Object.values(store.accounts).filter(
      (a) => a.email === idClaims.email && a.accountKey !== accountKey
    ).length;

    const record = {
      accountKey,
      label:
        prevRecord.label ||
        (sameEmailCount > 0 ? `${idClaims.email || idClaims.sub} (${issuedClientId.slice(-6)})` : idClaims.email || idClaims.sub),
      email: idClaims.email || prevRecord.email || '',
      name: idClaims.name || prevRecord.name || '',
      issuer: oidc.issuer,
      subject: idClaims.sub,
      client_id: issuedClientId,
      ext_agent_host_id: tx.extAgentHostId,
      id_token: tokenData.id_token,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || '',
      token_type: tokenData.token_type || 'Bearer',
      expires_in: Number(tokenData.expires_in || 3600),
      earliest_refresh_at: tokenData.earliest_refresh_at || null,
      scopes: grantedScopes,
      plan_usage_enabled: planUsageEnabled,
      first_sign_in_confirmed: Boolean(prevRecord.first_sign_in_confirmed),
      selected_model: prevRecord.selected_model || null,
      signed_out: false,
      needs_reauth: false,
      saved_at: nowIso,
      updated_at: nowIso,
      credential_version: crypto.randomUUID(),
    };

    store.accounts[accountKey] = record;
    store.activeAccountKey = accountKey;
    this.saveStore(store);

    return this.getPublicAccountSummary(record);
  }

  async refreshAccessToken(accountKey) {
    if (this.refreshLocks.has(accountKey)) {
      return this.refreshLocks.get(accountKey);
    }

    const promise = (async () => {
      const store = this.loadStore();
      const record = store.accounts[accountKey];
      if (!record || !record.refresh_token || !record.client_id) {
        const err = new Error('No refresh token available; please sign in again.');
        err.code = 'reauth_required';
        throw err;
      }

      const oidc = await this.getOidcConfig();
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: record.client_id,
        refresh_token: record.refresh_token,
        resource: OPENAI_API_RESOURCE,
      });

      const resp = await this.fetchImpl(oidc.token_endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });

      const data = await resp.json().catch(() => ({}));
      const currentStore = this.loadStore();
      const current = currentStore.accounts[accountKey];
      if (!current || current.signed_out || current.credential_version !== record.credential_version ||
          current.refresh_token !== record.refresh_token || current.access_token !== record.access_token) {
        if (typeof data.refresh_token === 'string' && data.refresh_token && oidc.revocation_endpoint) {
          await this.fetchImpl(oidc.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: data.refresh_token, token_type_hint: 'refresh_token', client_id: record.client_id }),
            signal: AbortSignal.timeout(10_000),
          }).catch(() => {});
        }
        throw Object.assign(new Error('ChatGPT session changed during refresh. Sign in again.'), { code: 'reauth_required' });
      }
      Object.assign(record, current);
      if (!resp.ok) {
        const errCode = data.error || `http_${resp.status}`;
        if (TERMINAL_REFRESH_ERRORS.has(errCode)) {
          record.access_token = '';
          record.refresh_token = '';
          record.id_token = '';
          record.needs_reauth = true;
          record.updated_at = new Date().toISOString();
          currentStore.accounts[accountKey] = record;
          this.saveStore(currentStore);
        }
        const err = new Error(data.error_description || errCode);
        err.code = errCode;
        err.status = resp.status;
        throw err;
      }

      const grantedScopes = data.scope
        ? String(data.scope).split(/\s+/).filter(Boolean)
        : record.scopes || [];

      if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new Error('Refresh response missing access token');
      }
      record.access_token = data.access_token;
      if (data.refresh_token) record.refresh_token = data.refresh_token;
      if (data.id_token) record.id_token = data.id_token;
      record.expires_in = Number(data.expires_in || 3600);
      record.earliest_refresh_at = data.earliest_refresh_at || null;
      record.scopes = grantedScopes;
      record.plan_usage_enabled = grantedScopes.includes(PLAN_USAGE_SCOPE);
      record.needs_reauth = false;
      record.saved_at = new Date().toISOString();
      record.updated_at = record.saved_at;
      record.credential_version = crypto.randomUUID();
      currentStore.accounts[accountKey] = record;
      this.saveStore(currentStore);

      return record;
    })();

    this.refreshLocks.set(accountKey, promise);
    try {
      return await promise;
    } finally {
      this.refreshLocks.delete(accountKey);
    }
  }

  async getValidAccessToken(accountKey = null) {
    const store = this.loadStore();
    const key = accountKey || store.activeAccountKey;
    if (!key || !store.accounts[key]) {
      const err = new Error('Not signed in with ChatGPT.');
      err.code = 'not_signed_in';
      throw err;
    }

    let record = store.accounts[key];
    if (record.signed_out || record.needs_reauth || !record.access_token) {
      const err = new Error('ChatGPT session is signed out or requires re-authentication.');
      err.code = 'reauth_required';
      throw err;
    }

    if (!record.plan_usage_enabled || !record.scopes?.includes(PLAN_USAGE_SCOPE)) {
      const err = new Error('ChatGPT plan usage scope (chatgpt.tokens.use.direct) is not enabled.');
      err.code = 'plan_usage_not_enabled';
      throw err;
    }

    const savedMs = Date.parse(record.saved_at || 0);
    const expiresMs = savedMs + Number(record.expires_in || 3600) * 1000;
    if (Date.now() >= expiresMs - 90_000) {
      record = await this.refreshAccessToken(key);
      if (!record.plan_usage_enabled) {
        const err = new Error('ChatGPT plan usage scope is not enabled after token refresh.');
        err.code = 'plan_usage_not_enabled';
        throw err;
      }
    }

    return {
      accountKey: key,
      accessToken: record.access_token,
      selectedModel: record.selected_model,
      record,
    };
  }

  async listModels(accountKey = null) {
    const { accessToken, accountKey: resolvedKey, record } = await this.getValidAccessToken(accountKey);
    const resp = await this.fetchImpl(`${OPENAI_API_RESOURCE}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.detail || data.error?.message || `Models HTTP ${resp.status}`);
      err.status = resp.status;
      err.code = data.error?.code || `http_${resp.status}`;
      throw err;
    }
    const rawModels = Array.isArray(data.models) ? data.models : [];
    const models = rawModels
      .filter((m) => m && m.visibility === 'list')
      .map((m) => ({
        slug: m.slug,
        display_name: m.display_name || m.slug,
      }));

    if (models.length > 0 && !record.selected_model) {
      const store = this.loadStore();
      if (store.accounts[resolvedKey]) {
        store.accounts[resolvedKey].selected_model = models[0].slug;
        this.saveStore(store);
      }
    }
    return models;
  }

  async signOut(accountKey = null) {
    const store = this.loadStore();
    const key = accountKey || store.activeAccountKey;
    if (!key || !store.accounts[key]) {
      return { ok: true, remoteRevoked: true };
    }
    const record = { ...store.accounts[key] };
    const clearedRecord = {
      ...record,
      access_token: '',
      refresh_token: '',
      id_token: '',
      signed_out: true,
      needs_reauth: false,
      credential_version: crypto.randomUUID(),
      updated_at: new Date().toISOString(),
    };
    store.accounts[key] = clearedRecord;
    if (store.activeAccountKey === key) {
      const nextActive = Object.values(store.accounts).find((a) => !a.signed_out && a.access_token);
      store.activeAccountKey = nextActive ? nextActive.accountKey : null;
    }
    this.saveStore(store);
    let remoteRevoked = true;
    let revocationError = null;

    if (record.refresh_token && record.client_id) {
      let oidc;
      try {
        oidc = await this.getOidcConfig();
      } catch (err) {
        return { ok: true, remoteRevoked: false, revocationError: err.message };
      }
      const body = new URLSearchParams({
        token: record.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: record.client_id,
      });

      remoteRevoked = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await this.fetchImpl(oidc.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
          });
          if (resp.status === 200) {
            remoteRevoked = true;
            break;
          }
          if (resp.status >= 400 && resp.status < 500) {
            revocationError = `HTTP ${resp.status}`;
            break;
          }
        } catch (err) {
          revocationError = err.message;
        }
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }

    return { ok: true, remoteRevoked, revocationError };
  }

  selectAccount(accountKey) {
    const store = this.loadStore();
    if (!store.accounts[accountKey]) {
      throw new Error('Unknown ChatGPT account registration');
    }
    store.activeAccountKey = accountKey;
    this.saveStore(store);
    return this.getPublicStatus();
  }

  selectModel(modelSlug, accountKey = null) {
    const store = this.loadStore();
    const key = accountKey || store.activeAccountKey;
    if (!key || !store.accounts[key]) {
      throw new Error('No active ChatGPT account');
    }
    store.accounts[key].selected_model = modelSlug;
    store.accounts[key].updated_at = new Date().toISOString();
    this.saveStore(store);
    return this.getPublicStatus();
  }

  confirmWelcome(accountKey = null) {
    const store = this.loadStore();
    const key = accountKey || store.activeAccountKey;
    if (!key || !store.accounts[key]) return this.getPublicStatus();
    store.accounts[key].first_sign_in_confirmed = true;
    store.accounts[key].updated_at = new Date().toISOString();
    this.saveStore(store);
    return this.getPublicStatus();
  }

  getPublicAccountSummary(record) {
    if (!record) return null;
    return {
      accountKey: record.accountKey,
      label: record.label,
      email: record.email,
      name: record.name,
      subject: record.subject,
      client_id: record.client_id,
      scopes: record.scopes || [],
      planUsageEnabled: Boolean(record.plan_usage_enabled),
      signedIn: Boolean(!record.signed_out && record.access_token),
      signedOut: Boolean(record.signed_out),
      needsReauth: Boolean(record.needs_reauth),
      firstSignInConfirmed: Boolean(record.first_sign_in_confirmed),
      selectedModel: record.selected_model || null,
      savedAt: record.saved_at || null,
    };
  }

  getPublicStatus() {
    const hostId = this.getOrCreateHostId();
    const store = this.loadStore();
    const accounts = Object.values(store.accounts).map((r) => this.getPublicAccountSummary(r));
    const active = store.activeAccountKey
      ? this.getPublicAccountSummary(store.accounts[store.activeAccountKey])
      : null;

    return {
      extAgentHostId: hostId,
      activeAccountKey: store.activeAccountKey,
      activeAccount: active,
      accounts,
      manageUsageUrl: 'https://chatgpt.com/settings/usage',
    };
  }
}
