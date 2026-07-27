// Op-log v2 integrity tests (Finding #13): Ed25519 signing, per-device sequence
// continuity, timestamp clamp, and legacy v1 passthrough.
//
// Run: node --loader ./test/_sodium-resolve.mjs --test test/oplog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpLogWriter, readAllEvents, readEventsSince, reduce, encodeSignedChunk, OPLOG_V2_MAGIC } from '../dist/oplog/index.js';
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

// ── Theorem 2: LWW merge determinism (reduce is permutation-invariant) ───────
// materialize(π(E)) = materialize(E) for any permutation π. The (ts, deviceId,
// seq) order is strict-total (seq is unique per device); tombstoned deletes
// extend order-independence to delete/set interleavings.

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}
const node = (op, id, ts, deviceId, seq, after) =>
  ({ graphId: 'g1', op, target: { kind: 'node', id }, ts, deviceId, seq, after });
// Canonical snapshot of graph g1's surviving nodes: "id=data" pairs, sorted.
function snapshot(events) {
  const g = reduce(events).get('g1');
  if (!g) return '<empty>';
  const s = [...g.nodes.entries()].map(([id, e]) => `${id}=${JSON.stringify(e.data)}`).sort().join('|');
  return s || '<empty>';
}
function allPermsAgree(events) {
  const perms = permutations(events);
  const outcomes = new Set(perms.map(snapshot));
  return { distinct: outcomes.size, only: [...outcomes][0], count: perms.length };
}

test('reduce determinism: same-device same-ts upserts → highest seq wins, order-independent', () => {
  const events = [
    node('addNode', 'K', 100, 'devA', 0, 'A0'),
    node('addNode', 'K', 100, 'devA', 1, 'A1'),
    node('addNode', 'K', 100, 'devA', 2, 'A2'),
  ];
  const r = allPermsAgree(events);
  assert.equal(r.distinct, 1, `expected one outcome across ${r.count} permutations, got ${r.distinct}`);
  assert.equal(r.only, 'K="A2"', 'highest seq (A2) must win');
});

test('reduce determinism: cross-device delete/set interleave is order-independent (tombstone)', () => {
  // devB sets K at ts=3; devA deletes K at ts=5. The newer delete outranks the
  // set → K absent regardless of merge order. Without tombstones this case was
  // order-dependent (delete-first → resurrected; set-first → deleted).
  const events = [
    node('addNode', 'K', 3, 'devB', 0, 'B-set'),
    node('deleteNode', 'K', 5, 'devA', 0, null),
  ];
  const r = allPermsAgree(events);
  assert.equal(r.distinct, 1, `delete/set interleave must be order-independent, got ${r.distinct}`);
  assert.equal(r.only, '<empty>', 'newer delete must win → K absent');
});

test('reduce determinism: newer set after delete resurrects (correct LWW), order-independent', () => {
  const events = [
    node('deleteNode', 'K', 3, 'devA', 0, null),
    node('addNode', 'K', 7, 'devB', 0, 'B-newer'),
  ];
  const r = allPermsAgree(events);
  assert.equal(r.distinct, 1);
  assert.equal(r.only, 'K="B-newer"', 'newer set outranks older delete → K present');
});

test('reduce determinism: mixed multi-key event set is permutation-invariant (720 perms)', () => {
  const events = [
    node('addNode', 'K', 100, 'devA', 0, 'A0'),
    node('addNode', 'K', 100, 'devA', 1, 'A1'),
    node('addNode', 'K', 100, 'devB', 0, 'B0'),
    node('deleteNode', 'K', 100, 'devC', 0, null), // devC highest deviceId at ts=100 → delete wins → K absent
    node('addNode', 'L', 50, 'devA', 2, 'L-old'),
    node('addNode', 'L', 90, 'devB', 0, 'L-new'),
  ];
  const r = allPermsAgree(events);
  assert.equal(r.distinct, 1, `expected permutation-invariant materialize across ${r.count} permutations, got ${r.distinct}`);
  assert.equal(r.only, 'L="L-new"', 'K deleted by highest-ranked devC; L resolves to newer L-new');
});

// ── Round-1 review finding #4: a signed chunk must BIND its inner events ──────
// The signature covers only (deviceId, startSeq, count, sha256(ct)). A device that
// holds the shared per-cortex data key can therefore sign a valid header of its own
// while encrypting events that claim another device's identity and rank.

const fullEv = (id, deviceId, seq) => ({
  id: `e-${id}`, ts: 1700000000000, deviceId, sessionId: 's1',
  graphId: 'g1', op: 'addNode', target: { kind: 'node', id }, after: { text: id }, seq,
});

function writeChunkFile(dir, name, chunk) {
  writeFileSync(join(dir, name), Buffer.concat([Buffer.from(OPLOG_V2_MAGIC), Buffer.from(chunk)]));
}

test('cross-device forgery: an A-signed chunk carrying a devB event is rejected', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  // devA signs a well-formed header of its own, but the payload claims devB.
  const chunk = await encodeSignedChunk('devA', [fullEv('n1', 'devB', 0)], key, salt, kp.secretKey);
  writeChunkFile(dir, 'devA.oplog', chunk);

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => kp.publicKey,
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 0, 'a forged cross-device event must not be admitted');
  assert.ok(
    issues.some((i) => i.kind === 'signature-invalid' && /cross-device forgery/.test(i.detail)),
    `expected a cross-device rejection, got ${JSON.stringify(issues)}`,
  );
});

test('pruned chunk: seq gaps from compaction are still accepted', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  // Compaction prunes events and leaves gaps: 0, 5, 9 is a legitimate chunk.
  const batch = [fullEv('n0', 'devA', 0), fullEv('n5', 'devA', 5), fullEv('n9', 'devA', 9)];
  writeChunkFile(dir, 'devA.oplog', await encodeSignedChunk('devA', batch, key, salt, kp.secretKey));

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => kp.publicKey,
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 3, 'pruning gaps are legitimate and must not be rejected');
  assert.deepEqual(events.map((e) => e.seq), [0, 5, 9]);
  assert.equal(issues.filter((i) => i.kind === 'signature-invalid').length, 0,
    `pruned chunk wrongly rejected: ${JSON.stringify(issues)}`);
});

test('rank tampering: non-ascending seq inside a chunk is rejected', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const batch = [fullEv('n0', 'devA', 0), fullEv('n5', 'devA', 5), fullEv('n2', 'devA', 2)];
  writeChunkFile(dir, 'devA.oplog', await encodeSignedChunk('devA', batch, key, salt, kp.secretKey));

  const issues = [];
  const events = await readAllEvents(dir, key, {
    getDevicePubKey: () => kp.publicKey,
    onIntegrityIssue: (i) => issues.push(i),
  });
  assert.equal(events.length, 0, 'a chunk whose ranks move backwards must be rejected whole');
  assert.ok(issues.some((i) => i.kind === 'signature-invalid' && /strictly ascending/.test(i.detail)),
    `expected an ordering rejection, got ${JSON.stringify(issues)}`);
});

// ── Shutdown durability (Finding: seq allocated but never flushed) ──────────

test('persistSeq never runs ahead of what was actually written', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const persisted = [];
  const w = new OpLogWriter({
    dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey,
    persistSeq: async (s) => { persisted.push(s); },
  });

  // Emit a burst. The first emit starts a flush; the rest queue behind it, so the
  // in-memory counter runs ahead of the batch being written. Persisting the
  // COUNTER here is what used to mark still-buffered ranks as durable — the next
  // launch resumed past them and those events were gone.
  for (let i = 0; i < 25; i++) w.emit(ev(`n${i}`));
  await w.drain();

  const events = await readAllEvents(dir, key, { getDevicePubKey: () => kp.publicKey });
  const maxWritten = Math.max(...events.map((e) => e.seq));

  assert.equal(events.length, 25, 'every emitted event must reach disk after drain()');
  for (const p of persisted) {
    assert.ok(p <= maxWritten + 1,
      `persisted resume point ${p} exceeds the highest written seq ${maxWritten} — ` +
      'events would be skipped on the next launch');
  }
});

test('drain() leaves no gaps in the written sequence', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });
  for (let i = 0; i < 40; i++) w.emit(ev(`n${i}`));
  await w.drain();

  const events = await readAllEvents(dir, key, { getDevicePubKey: () => kp.publicKey });
  const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 40 }, (_, i) => i),
    'a clean shutdown must produce a contiguous run — gaps here are lost events');
});

test('a failed flush returns its batch to the buffer instead of dropping it', async () => {
  const dir = freshDir();
  const { key, salt, kp } = await setup();
  const w = new OpLogWriter({ dir, deviceId: 'devA', key, salt, signSecretKey: kp.secretKey });

  w.emit(ev('keep-me'));
  // Force the write to fail once. The batch is spliced out of the buffer before
  // the awaits, so without restore-on-error it would be gone for good.
  const realDir = w.opts?.dir;
  let threw = false;
  try {
    Object.defineProperty(w, 'opts', { value: { ...w.opts, dir: '/proc/nonexistent-cannot-mkdir' }, writable: true });
    await w.flush();
  } catch { threw = true; }
  Object.defineProperty(w, 'opts', { value: { ...w.opts, dir: realDir ?? dir }, writable: true });

  if (threw) {
    await w.drain();
    const events = await readAllEvents(dir, key, { getDevicePubKey: () => kp.publicKey });
    assert.equal(events.length, 1, 'the event survived a failed flush and was written on retry');
  }
});
