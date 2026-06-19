// Op-log v2 integrity tests (Finding #13): Ed25519 signing, per-device sequence
// continuity, timestamp clamp, and legacy v1 passthrough.
//
// Run: node --loader ./test/_sodium-resolve.mjs --test test/oplog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpLogWriter, readAllEvents, readEventsSince } from '../dist/oplog/index.js';
import { deriveKey, generateSigningKeyPair } from '../dist/crypto/index.js';

function freshDir() { return mkdtempSync(join(tmpdir(), 'gn-oplog-')); }
const ev = (id) => ({ graphId: 'g1', op: 'addNode', target: { kind: 'node', id }, after: { text: id } });
async function flushAll(w) { await w.flush(); await new Promise((r) => setTimeout(r, 30)); }

async function setup() {
  const { key, salt } = await deriveKey('test-pass');
  const kp = await generateSigningKeyPair();
  return { key, salt, kp };
}

test('signed round-trip: events read back, signature verifies, no issues', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });
  w.emit(ev('n1')); w.emit(ev('n2')); w.emit(ev('n3'));
  await flushAll(w);

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: (d) => (d === 'devA' ? kp.publicKey : undefined),
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.target.id).sort(), ['n1', 'n2', 'n3']);
  assert.equal(issues.length, 0, `unexpected issues: ${JSON.stringify(issues)}`);
  assert.deepEqual(events.map((e) => e.seq).sort((a, b) => a - b), [0, 1, 2]);
});

test('forged content: a flipped byte fails the content hash and the chunk is dropped', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });
  w.emit(ev('n1'));
  await flushAll(w);

  // Tamper the last byte (inside the ciphertext region).
  const file = join(dir, 'devA.oplog');
  const bytes = readFileSync(file);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(file, bytes);

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => kp.publicKey,
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 0, 'tampered chunk must not yield events');
  assert.ok(issues.some((i) => i.kind === 'signature-invalid'), `expected signature-invalid, got ${JSON.stringify(issues)}`);
});

test('unknown device (no pinned key) is not trusted', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });
  w.emit(ev('n1'));
  await flushAll(w);

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => undefined, // device not in registry
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 0);
  assert.ok(issues.some((i) => i.kind === 'unknown-device'));
});

test('wrong device key fails verification', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const other = await generateSigningKeyPair();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });
  w.emit(ev('n1'));
  await flushAll(w);

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => other.publicKey, // attacker-substituted key
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 0);
  assert.ok(issues.some((i) => i.kind === 'signature-invalid'));
});

test('sequence gap (dropped events) is detected', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w1 = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey, initialSeq: 0 });
  w1.emit(ev('n0')); w1.emit(ev('n1'));
  await flushAll(w1);
  // A later writer resumes far ahead → gap between seq 1 and 10.
  const w2 = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey, initialSeq: 10 });
  w2.emit(ev('n10'));
  await flushAll(w2);

  const issues = [];
  await readAllEvents(dir, key, { getDevicePubKey: () => kp.publicKey, onIntegrityIssue: (i) => issues.push(i) });
  assert.ok(issues.some((i) => i.kind === 'seq-gap'), `expected seq-gap, got ${JSON.stringify(issues)}`);
});

test('sequence rewind (replay) is detected', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w1 = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey, initialSeq: 0 });
  w1.emit(ev('n0')); w1.emit(ev('n1')); w1.emit(ev('n2'));
  await flushAll(w1);
  // Replay: a writer re-emits seqs that already exist.
  const w2 = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey, initialSeq: 1 });
  w2.emit(ev('n1-replay'));
  await flushAll(w2);

  const issues = [];
  await readAllEvents(dir, key, { getDevicePubKey: () => kp.publicKey, onIntegrityIssue: (i) => issues.push(i) });
  assert.ok(issues.some((i) => i.kind === 'seq-rewind'), `expected seq-rewind, got ${JSON.stringify(issues)}`);
});

test('future-timestamp events are clamped (dropped)', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });
  w.emit(ev('n1'));
  await flushAll(w);

  const issues = [];
  // Pin "now" to the epoch with zero skew → the real Date.now() ts looks future.
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => kp.publicKey,
    now: 1, maxClockSkewMs: 0,
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 0);
  assert.ok(issues.some((i) => i.kind === 'future-timestamp'));
});

test('readEventsSince returns only events after checkpoint', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });
  const readOpts = {
    getDevicePubKey: () => kp.publicKey,
    onIntegrityIssue: () => {},
  };

  let checkpoint = { maxTs: 0, maxSeq: -1 };
  for (let i = 0; i < 100; i++) {
    const emitted = w.emit({ ...ev(`pre-${i}`), ts: 1000 + i, seq: i });
    if (i === 99) checkpoint = { maxTs: emitted.ts, maxSeq: emitted.seq };
  }
  await flushAll(w);

  for (let i = 100; i < 110; i++) {
    w.emit({ ...ev(`tail-${i}`), ts: 1000 + i, seq: i });
  }
  await flushAll(w);

  const all = await readAllEvents(dir, key, readOpts);
  assert.equal(all.length, 110);

  const tail = await readEventsSince(dir, key, {
    ...readOpts,
    sinceTs: checkpoint.maxTs,
    sinceSeq: checkpoint.maxSeq,
  });
  assert.equal(tail.length, 10, `expected 10 tail events, got ${tail.length}`);
  assert.ok(tail.every((e) => e.target.id.startsWith('tail-')));
});

test('legacy v1 (unsigned) files are still read', async () => {
  const dir = freshDir();
  const { key, salt } = await setup();
  // No signSecretKey → legacy v1 framing.
  const w = new OpLogWriter({ dir, deviceId: 'legacy-host-123', key, salt });
  w.emit(ev('old1')); w.emit(ev('old2'));
  await flushAll(w);

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => undefined,
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 2, 'legacy events must be grandfathered');
});
