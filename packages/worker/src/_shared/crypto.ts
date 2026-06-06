const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const SEALED_JSON_V2 = 'v2.';
const SEALED_JSON_V1 = 'v1.';
const HKDF_SALT = textEncoder.encode('nimbus-sh sealed-json v2');
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

export interface SealedJsonOptions {
  purpose?: string;
  minSecretLength?: number;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return base64Url(new Uint8Array(digest));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

export async function sealJson(
  value: unknown,
  secret: string,
  options: SealedJsonOptions = {},
): Promise<string> {
  const purpose = normalizePurpose(options.purpose);
  const key = await hkdfAesGcmKey(secret, purpose, options.minSecretLength);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(purpose) },
    key,
    plaintext,
  ));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return SEALED_JSON_V2 + base64Url(packed);
}

export async function unsealJson<T>(
  value: string,
  secret: string,
  options: SealedJsonOptions = {},
): Promise<T | null> {
  if (value.startsWith(SEALED_JSON_V2)) {
    const purpose = normalizePurpose(options.purpose);
    const packed = base64UrlDecode(value.slice(SEALED_JSON_V2.length));
    if (packed.length <= 12) return null;
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const key = await hkdfAesGcmKey(secret, purpose, options.minSecretLength);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(purpose) },
      key,
      ciphertext,
    );
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  }

  // Backward compatibility for the original agent OAuth cookie format.
  // New cookies are always v2 and purpose-bound through AES-GCM AAD.
  if (value.startsWith(SEALED_JSON_V1)) {
    const packed = base64UrlDecode(value.slice(SEALED_JSON_V1.length));
    if (packed.length <= 12) return null;
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    const key = await legacyShaAesGcmKey(secret, options.minSecretLength);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  }

  return null;
}

export function encodeJsonBase64Url(value: unknown): string {
  return base64Url(textEncoder.encode(JSON.stringify(value)));
}

export function decodeJsonBase64Url<T>(value: string): T {
  return JSON.parse(textDecoder.decode(base64UrlDecode(value))) as T;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL_RE.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid base64url input');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64Utf8(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function hkdfAesGcmKey(
  secret: string,
  purpose: string,
  minSecretLength = 32,
): Promise<CryptoKey> {
  assertSecret(secret, minSecretLength);
  const material = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: textEncoder.encode(purpose),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function legacyShaAesGcmKey(secret: string, minSecretLength = 32): Promise<CryptoKey> {
  assertSecret(secret, minSecretLength);
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt']);
}

function assertSecret(secret: string, minSecretLength: number): void {
  if (!secret || secret.length < minSecretLength) {
    throw new Error(`Sealed JSON secret must be ${minSecretLength}+ characters`);
  }
}

function normalizePurpose(purpose: string | undefined): string {
  const value = (purpose || 'default').trim();
  if (!value) return 'default';
  return value.slice(0, 128);
}

function aad(purpose: string): Uint8Array {
  return textEncoder.encode(`nimbus-sh:${purpose}:sealed-json:v2`);
}
