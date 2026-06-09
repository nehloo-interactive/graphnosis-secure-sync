// Regression test for the recovery-wrap key/salt derivation.
//
// Bug history: makeRecoveryWrap previously called deriveKey(phrase) twice — once for
// the wrapping key, once for the salt stored in the blob — minting two independent
// random salts. The key was derived under salt A while the blob stored salt B, so
// unwrapRecovery (which re-derives the key from the stored salt) could never recover
// it. Every recovery wrap was permanently undecryptable. This test pins the fix.
//
// Run: node --loader ./test/_sodium-resolve.mjs --test test/recovery.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecoveryWrap, unwrapRecovery } from '../dist/crypto/index.js';

const dataKey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
const phrase = 'correct horse battery staple recovery phrase test';

test('recovery wrap round-trips back to the original data key', async () => {
  const wrap = await makeRecoveryWrap(dataKey, phrase);
  const back = await unwrapRecovery(wrap, phrase);
  assert.deepEqual(Array.from(back), Array.from(dataKey));
});

test('recovery wrap rejects the wrong phrase', async () => {
  const wrap = await makeRecoveryWrap(dataKey, phrase);
  await assert.rejects(() => unwrapRecovery(wrap, 'a different phrase entirely'));
});
