export const COMPANION_URL = 'http://127.0.0.1:17864';

export async function companionRequest(path, { method = 'GET', body, signal } = {}) {
  const headers = {};
  if (method === 'POST') {
    const { pairingCode } = await chrome.storage.local.get('pairingCode');
    headers['X-YT-Client'] = '1';
    headers['X-YT-Pair'] = pairingCode || '';
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(COMPANION_URL + path, {
    method, headers, signal,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, data: await response.json() };
}
