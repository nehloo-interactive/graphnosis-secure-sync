import test from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers-sumo';
import { encrypt, decrypt } from '../dist/crypto/index.js';

await sodium.ready;

const MAGIC_LEN = 6;
const SALT_LEN = () => sodium.crypto_pwhash_SALTBYTES;
const HDR_LEN = () => sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;

function setup() {
  return {
    key: sodium.crypto_secretstream_xchacha20poly1305_keygen(),
    salt: sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES),
  };
}

/** Byte offsets at which each secretstream chunk ends. Cutting here leaves every
 *  surviving chunk individually valid — the case a length-only reader cannot see. */
function chunkBoundaries(ct) {
  const out = [];
  let cur = MAGIC_LEN + SALT_LEN() + HDR_LEN();
  while (cur < ct.length) {
    const len = new DataView(ct.buffer, ct.byteOffset + cur, 4).getUint32(0, true);
    cur += 4 + len;
    out.push(cur);
  }
  return out;
}

/** Must exceed the 64 KiB chunk size, or there is a single chunk carrying
 *  TAG_FINAL and there is nothing to truncate. */
function multiChunkPlaintext(lines = 6000) {
  return new TextEncoder().encode(
    Array.from({ length: lines }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join('\n'),
  );
}

test('round-trips an ordinary payload', async () => {
  const { key, salt } = setup();
  const plain = new TextEncoder().encode('hello cortex');
  assert.deepEqual(await decrypt(await encrypt(plain, key, salt), key), plain);
});

test('round-trips a multi-chunk payload', async () => {
  const { key, salt } = setup();
  const plain = multiChunkPlaintext();
  const ct = await encrypt(plain, key, salt);
  assert.ok(chunkBoundaries(ct).length > 1, 'fixture must span several chunks');
  assert.deepEqual(await decrypt(ct, key), plain);
});

test('round-trips an EMPTY payload', async () => {
  // Empty plaintext now encodes as one chunk carrying TAG_FINAL rather than zero
  // chunks, so it is distinguishable from a stream truncated to nothing.
  const { key, salt } = setup();
  const out = await decrypt(await encrypt(new Uint8Array(0), key, salt), key);
  assert.equal(out.length, 0);
});

test('truncation at a chunk boundary is REJECTED, not silently accepted', async () => {
  const { key, salt } = setup();
  const plain = multiChunkPlaintext();
  const ct = await encrypt(plain, key, salt);
  const bounds = chunkBoundaries(ct);
  assert.ok(bounds.length >= 3, 'need several chunks to test suffix removal');

  // Every prefix that stops on a boundary before the last chunk must be refused.
  // Each one is individually authentic; what it is not is COMPLETE. Accepting it
  // would hand back part of a memory as though it were all of it.
  for (let k = 1; k < bounds.length; k++) {
    await assert.rejects(
      () => decrypt(ct.subarray(0, bounds[k - 1]), key),
      /truncated/i,
      `truncation keeping ${k}/${bounds.length} chunks was accepted`,
    );
  }
});

test('a bit flip anywhere in the stream is still rejected', async () => {
  const { key, salt } = setup();
  const ct = await encrypt(multiChunkPlaintext(200), key, salt);
  const bad = Uint8Array.from(ct);
  bad[Math.floor(bad.length / 2)] ^= 0xff;
  await assert.rejects(() => decrypt(bad, key));
});

test('appending data after the final chunk is rejected', async () => {
  const { key, salt } = setup();
  const a = await encrypt(new TextEncoder().encode('first payload'), key, salt);
  const b = await encrypt(new TextEncoder().encode('second payload'), key, salt);
  // Splice B's body onto a complete A: A already carries TAG_FINAL, so anything
  // following it is by definition not part of this stream.
  const bBody = b.subarray(MAGIC_LEN + SALT_LEN() + HDR_LEN());
  const glued = new Uint8Array(a.length + bBody.length);
  glued.set(a, 0);
  glued.set(bBody, a.length);
  await assert.rejects(() => decrypt(glued, key), /after its final chunk|truncated|Decryption failed/i);
});

test('a foreign blob is rejected by magic', async () => {
  const { key } = setup();
  await assert.rejects(() => decrypt(new Uint8Array(64), key), /Not a Graphnosis App encrypted blob/);
});
