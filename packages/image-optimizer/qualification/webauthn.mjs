// A software passkey (WebAuthn ES256, "none" attestation) for driving EmDash's own setup, invite and
// login routes from a script. The key pair lives in memory for one run only and is never written.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** Minimal CBOR encoder: unsigned and negative integers, byte strings, text strings and maps. */
function cbor(value) {
  const head = (major, length) => {
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(length, 1);
    return out;
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
    return Buffer.concat(parts);
  }
  throw new TypeError(`Cannot CBOR-encode ${typeof value}`);
}

export function createPasskey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(16);
  let counter = 0;

  const clientData = (type, challenge, origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
  const rpIdHash = (rpId) => createHash('sha256').update(rpId).digest();
  const count = () => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(++counter, 0);
    return out;
  };

  return {
    id: b64url(credentialId),
    /** The response of `navigator.credentials.create()` for registration options from EmDash. */
    register(options, origin) {
      const cose = new Map([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length, 0);
      const authData = Buffer.concat([
        rpIdHash(options.rp.id),
        Buffer.from([0x45]), // user present, user verified, attested credential data
        count(),
        Buffer.alloc(16), // AAGUID
        idLength,
        credentialId,
        cbor(cose),
      ]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', options.challenge, origin)),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        authenticatorAttachment: 'platform',
      };
    },
    /** The response of `navigator.credentials.get()` for authentication options from EmDash. */
    authenticate(options, origin) {
      const data = clientData('webauthn.get', options.challenge, origin);
      const authData = Buffer.concat([rpIdHash(options.rpId), Buffer.from([0x05]), count()]);
      const message = Buffer.concat([authData, createHash('sha256').update(data).digest()]);
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64url(data),
          authenticatorData: b64url(authData),
          signature: b64url(sign('sha256', message, privateKey)), // DER, as authenticators produce
        },
        authenticatorAttachment: 'platform',
      };
    },
  };
}
