// A small HTTP client for one browser-like identity: a cookie jar, and EmDash's CSRF header unless
// a call asks to leave it out. Responses are parsed as JSON when they are JSON.
import { createPasskey } from './webauthn.mjs';

export function createClient(origin, { name = 'client' } = {}) {
  const jar = new Map();

  function remember(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attributes] = line.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value === '';
      if (expired) jar.delete(key);
      else jar.set(key, value);
    }
  }

  async function request(method, path, { json, form, csrf = true, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (jar.size > 0) init.headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    if (csrf) init.headers['X-EmDash-Request'] = '1';
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form) {
      init.body = form;
    }
    const response = await fetch(`${origin}${path}`, init);
    remember(response);
    if (raw) return response;
    const type = response.headers.get('content-type') ?? '';
    const body = type.includes('json') ? await response.json() : await response.text();
    return { status: response.status, headers: response.headers, body };
  }

  return {
    name,
    origin,
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, json, options = {}) => request('POST', path, { ...options, json }),
    put: (path, json, options = {}) => request('PUT', path, { ...options, json }),
    hasSession: () => jar.size > 0,
    cookies: () => new Map(jar),
  };
}

function expectOk(result, what) {
  if (result.status >= 400) throw new Error(`${what}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  return result.body?.data ?? result.body;
}

/** First-run setup through EmDash's wizard routes, creating the admin with a software passkey. */
export async function setUpSite(origin, { title, email }) {
  const client = createClient(origin, { name: 'admin' });
  expectOk(await client.post('/_emdash/api/setup', { title, includeContent: false }), 'setup');
  const passkey = createPasskey();
  const { options } = expectOk(await client.post('/_emdash/api/setup/admin', { email, name: 'Qualification admin' }), 'setup/admin');
  expectOk(await client.post('/_emdash/api/setup/admin/verify', { credential: passkey.register(options, origin) }), 'setup/admin/verify');
  await logIn(client, passkey);
  return { client, passkey };
}

/** Passkey login: a session cookie in the client's jar. */
export async function logIn(client, passkey) {
  const options = expectOk(await client.post('/_emdash/api/auth/passkey/options', {}), 'passkey/options');
  const challenge = options.options ?? options;
  const result = expectOk(
    await client.post('/_emdash/api/auth/passkey/verify', { credential: passkey.authenticate(challenge, client.origin) }),
    'passkey/verify',
  );
  return result.user ?? result;
}

/** A second user invited by the admin with the given role, signed in with its own passkey. */
export async function inviteUser(admin, { email, role }) {
  const invite = expectOk(await admin.post('/_emdash/api/auth/invite', { email, role }), 'auth/invite');
  const url = invite.inviteUrl ?? invite.url;
  if (!url) throw new Error(`The invite returned no URL: ${JSON.stringify(invite)}`);
  const token = new URL(url, admin.origin).searchParams.get('token');
  const client = createClient(admin.origin, { name: `role-${role}` });
  const passkey = createPasskey();
  const { options } = expectOk(await client.post('/_emdash/api/auth/invite/register-options', { token }), 'invite/register-options');
  const done = expectOk(
    await client.post('/_emdash/api/auth/invite/complete', { token, credential: passkey.register(options, admin.origin) }),
    'invite/complete',
  );
  return { client, passkey, user: done.user ?? done };
}

export { expectOk };
