// libsodium-wrappers-sumo@0.7.16 ships a broken ESM entry (its .mjs imports a
// sibling `./libsodium-sumo.mjs` that the package doesn't include in its files
// array). Bundlers that pick the ESM `import` condition therefore fail to
// resolve. Consumers MUST override the package's exports so all conditions
// resolve to the CJS file:
//
//   "pnpm": {
//     "packageExtensions": {
//       "libsodium-wrappers-sumo": {
//         "exports": {
//           ".": {
//             "import":  "./dist/modules-sumo/libsodium-wrappers.js",
//             "require": "./dist/modules-sumo/libsodium-wrappers.js",
//             "default": "./dist/modules-sumo/libsodium-wrappers.js"
//           }
//         }
//       }
//     }
//   }
//
// We use a static `import` (no `createRequire` indirection) so that bundlers
// performing static analysis — Bun's `--compile`, esbuild, Vite, webpack —
// can see the dependency and include it in the output bundle. The previous
// `createRequire(import.meta.url)('libsodium-wrappers-sumo')` pattern made
// the dep invisible to static analyzers; Bun's compiled binaries crashed at
// runtime with "Cannot find package 'libsodium-wrappers-sumo'".
//
// Default-import works for both ESM and CJS variants because the package's
// CJS entry sets `module.exports = sodium` (default export), which ESM
// interop hoists to `import sodium from …`.
import sodium from 'libsodium-wrappers-sumo';

let ready: Promise<void> | null = null;
function init(): Promise<void> {
  if (!ready) ready = sodium.ready;
  return ready;
}

export interface DerivedKey {
  key: Uint8Array;
  salt: Uint8Array;
  opslimit: number;
  memlimit: number;
}

export async function deriveKey(passphrase: string, salt?: Uint8Array): Promise<DerivedKey> {
  await init();
  const s = salt ?? sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const opslimit = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  const memlimit = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
    passphrase,
    s,
    opslimit,
    memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return { key, salt: s, opslimit, memlimit };
}

const MAGIC = new TextEncoder().encode('GNAPP\x01');

export async function encrypt(plaintext: Uint8Array, key: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  await init();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const chunkSize = 64 * 1024;
  const chunks: Uint8Array[] = [];
  // Empty plaintext still gets ONE chunk, carrying TAG_FINAL. Without it an empty
  // payload would encode as zero chunks, which is indistinguishable from a stream
  // truncated to nothing — and `decrypt` now requires a FINAL tag to accept a
  // stream at all. Reading an empty body stays backward compatible (see decrypt).
  const lastOffset = Math.max(0, Math.ceil(plaintext.length / chunkSize) - 1) * chunkSize;
  for (let offset = 0; offset <= lastOffset; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, plaintext.length);
    const isFinal = offset === lastOffset;
    const tag = isFinal
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      plaintext.subarray(offset, end),
      null,
      tag,
    );
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, ct.length, true);
    chunks.push(len, ct);
  }
  const body = concat(chunks);
  return concat([MAGIC, salt, header, body]);
}

export async function decrypt(ciphertext: Uint8Array, passphraseOrKey: string | Uint8Array): Promise<Uint8Array> {
  await init();
  if (!startsWith(ciphertext, MAGIC)) throw new Error('Not a Graphnosis App encrypted blob');
  let cursor = MAGIC.length;
  const salt = ciphertext.subarray(cursor, cursor + sodium.crypto_pwhash_SALTBYTES);
  cursor += sodium.crypto_pwhash_SALTBYTES;
  const headerLen = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  const header = ciphertext.subarray(cursor, cursor + headerLen);
  cursor += headerLen;

  const key =
    typeof passphraseOrKey === 'string'
      ? (await deriveKey(passphraseOrKey, salt)).key
      : passphraseOrKey;

  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  const out: Uint8Array[] = [];

  // COMPLETENESS, as distinct from authenticity.
  //
  // Every chunk is individually authenticated, so a flipped bit is always caught.
  // What that does NOT establish is that the stream we read is the WHOLE stream:
  // secretstream marks the end with TAG_FINAL, and a reader that simply stops when
  // it runs out of bytes cannot tell a complete stream from one whose trailing
  // chunks were removed. Cutting at a chunk boundary leaves every surviving chunk
  // valid, so truncation returns an authenticated PREFIX of the real plaintext with
  // no error at all — silent, partial data presented as if it were everything.
  //
  // So the end marker is now required, and nothing may follow it.
  const bodyStart = cursor;
  let finalSeen = false;
  while (cursor < ciphertext.length) {
    if (finalSeen) {
      throw new Error('Encrypted stream has data after its final chunk (tampered file)');
    }
    const len = new DataView(
      ciphertext.buffer,
      ciphertext.byteOffset + cursor,
      4,
    ).getUint32(0, true);
    cursor += 4;
    const chunk = ciphertext.subarray(cursor, cursor + len);
    cursor += len;
    const r = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
    if (!r) throw new Error('Decryption failed (wrong passphrase or tampered file)');
    out.push(r.message);
    if (r.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) finalSeen = true;
  }

  if (!finalSeen) {
    // A body of zero bytes is the one legitimate case with no FINAL tag: writers
    // before this change encoded empty plaintext as zero chunks. Accept it (there
    // is no partial data to be misled by — the result is empty either way) and
    // reject everything else, which is a stream that started and did not finish.
    if (cursor === bodyStart) return new Uint8Array(0);
    throw new Error('Encrypted stream is truncated (ended before its final chunk)');
  }

  return concat(out);
}

// BIP-39-style recovery phrase: a separately-encrypted copy of the data-encryption key.
// The phrase is the entropy source for an Argon2id key that wraps the real key.
export async function makeRecoveryWrap(dataKey: Uint8Array, recoveryPhrase: string): Promise<Uint8Array> {
  // Derive ONCE: the wrapping key and the salt stored in the blob must come from the
  // same Argon2id pass. Calling deriveKey twice mints two independent random salts —
  // the key would be derived under salt A while the blob stores salt B, so
  // unwrapRecovery (which re-derives the key from the stored salt) could never recover
  // it. That made every recovery wrap permanently undecryptable.
  const dk = await deriveKey(recoveryPhrase);
  return encrypt(dataKey, dk.key, dk.salt);
}

export async function unwrapRecovery(blob: Uint8Array, recoveryPhrase: string): Promise<Uint8Array> {
  return decrypt(blob, recoveryPhrase);
}

// ── Ed25519 device-identity signatures (op-log v2) ──────────────────────────
//
// Each device owns an Ed25519 keypair. Op-log chunks are signed so a party that
// merely holds the shared data key (e.g. a stolen synced copy) cannot forge
// events attributed to *another* device. libsodium provides the primitives;
// these are thin wrappers that ensure `sodium.ready` before use.

export interface SigningKeyPair {
  publicKey: Uint8Array;  // 32 bytes
  secretKey: Uint8Array;  // 64 bytes (libsodium secret key)
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  await init();
  const kp = sodium.crypto_sign_keypair();
  return { publicKey: kp.publicKey, secretKey: kp.privateKey };
}

/** Detached Ed25519 signature (64 bytes) over `message`. */
export async function sign(message: Uint8Array, secretKey: Uint8Array): Promise<Uint8Array> {
  await init();
  return sodium.crypto_sign_detached(message, secretKey);
}

/** Verify a detached Ed25519 signature. Returns false on any malformed input
 *  rather than throwing, so a bad chunk is a rejection, not a crash. */
export async function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  await init();
  try {
    return sodium.crypto_sign_verify_detached(signature, message, publicKey);
  } catch {
    return false;
  }
}

export const SIGN_PUBLICKEYBYTES = 32;
export const SIGN_SECRETKEYBYTES = 64;
export const SIGN_BYTES = 64;

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function startsWith(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
