/** Edge-compatible verification; the database-backed role check stays in each API handler. */
export async function validManagementToken(
  token: string | undefined,
  secret: string | undefined,
  now = Date.now(),
) {
  if (!token || !secret || new TextEncoder().encode(secret).length < 32) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [rawId, rawExpires, signature] = parts;
  if (
    !Number.isSafeInteger(Number(rawId)) ||
    Number(rawId) <= 0 ||
    !Number.isSafeInteger(Number(rawExpires)) ||
    Number(rawExpires) < now
  )
    return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const encoder = new TextEncoder();
  const root = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const derived = await crypto.subtle.sign('HMAC', root, encoder.encode('lxl-admin:session'));
  const key = await crypto.subtle.importKey(
    'raw',
    derived,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(
    atob(signature.replaceAll('-', '+').replaceAll('_', '/')),
    (character) => character.charCodeAt(0),
  );
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`${rawId}.${rawExpires}`));
}
