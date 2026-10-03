// The check that the qualification proxy only passes requests on, against what Caddy 2.11 adapts
// the generated Caddyfile and some unsafe variants to.
import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPassThrough, caddyfile, describeConfig } from './proxy.mjs';

const ports = { proxyPort: 4511, sitePort: 4510 };

/** `caddy adapt` of `caddyfile(ports)`. */
const passThrough = () => ({
  admin: { disabled: true, config: { persist: false } },
  apps: {
    http: {
      servers: {
        srv0: {
          listen: ['127.0.0.1:4511'],
          routes: [
            {
              match: [{ host: ['127.0.0.1'] }],
              handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:4510' }] }] }] }],
              terminal: true,
            },
          ],
          automatic_https: { disable: true, skip: ['127.0.0.1'] },
        },
      },
    },
  },
});

/** `caddy adapt` of a site that also serves the uploads directory, on every interface. */
const servingUploads = () => ({
  apps: {
    http: {
      servers: {
        srv0: {
          listen: [':4511'],
          routes: [
            {
              match: [{ path: ['/uploads/*'] }],
              handle: [
                {
                  handler: 'subroute',
                  routes: [
                    { handle: [{ handler: 'rewrite', strip_path_prefix: '/uploads' }] },
                    { handle: [{ handler: 'vars', root: '/srv/data/uploads' }, { handler: 'file_server', hide: ['/etc/caddy/Caddyfile'] }] },
                  ],
                },
              ],
            },
            { handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:4510' }] }] },
          ],
          automatic_https: { disable: true },
        },
      },
    },
  },
});

test('the generated Caddyfile has one loopback site whose only directive is the reverse proxy', () => {
  const text = caddyfile(ports);
  assert.match(text, /^http:\/\/127\.0\.0\.1:4511 \{\n\tbind 127\.0\.0\.1\n\treverse_proxy 127\.0\.0\.1:4510\n\}$/m);
  assert.doesNotMatch(text, /file_server|root|handle|respond|tls/);
  assert.match(text, /admin off/);
});

test('the pass-through configuration is accepted and described', () => {
  const description = describeConfig(passThrough());
  assert.deepEqual(description, { listen: ['127.0.0.1:4511'], handlers: ['reverse_proxy', 'subroute'], upstreams: ['127.0.0.1:4510'], roots: [], admin: 'off' });
  assertPassThrough(description, ports);
});

test('a configuration that serves files, or listens beyond loopback, is refused', () => {
  const description = describeConfig(servingUploads());
  assert.deepEqual(description.roots, ['/srv/data/uploads']);
  assert.throws(() => assertPassThrough(description, ports), (error) => {
    for (const part of [/not on loopback alone/, /file_server/, /file-system root/, /admin endpoint on/]) assert.match(error.message, part);
    return true;
  });
});

test('each single departure from pass-through is refused on its own', () => {
  const variants = {
    'another interface': (config) => config.apps.http.servers.srv0.listen.push(':4511'),
    'no listener': (config) => (config.apps.http.servers.srv0.listen = []),
    'a file server': (config) => config.apps.http.servers.srv0.routes.push({ handle: [{ handler: 'file_server' }] }),
    'a root': (config) => config.apps.http.servers.srv0.routes.push({ handle: [{ handler: 'subroute', root: '/srv' }] }),
    'a static response': (config) => config.apps.http.servers.srv0.routes.push({ handle: [{ handler: 'static_response', body: 'x' }] }),
    'another upstream': (config) => config.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].upstreams.push({ dial: '127.0.0.1:9' }),
    'the wrong upstream': (config) => (config.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].upstreams[0].dial = '127.0.0.1:9'),
    'no proxy': (config) => (config.apps.http.servers.srv0.routes = []),
    'the admin endpoint': (config) => delete config.admin,
    'a second server': (config) => (config.apps.http.servers.srv1 = { listen: [':8080'], routes: [] }),
  };
  for (const [name, change] of Object.entries(variants)) {
    const config = passThrough();
    change(config);
    assert.throws(() => assertPassThrough(describeConfig(config), ports), /The proxy configuration/, name);
  }
});
