// Federation against a REAL cortex — seven `.gai` engrams, not hand-written
// candidate arrays.
//
// The rest of the federation suite injects a `runQuery` that returns literal
// objects, so every assertion in it is a statement about federation's
// arithmetic. This file is the statement about federation over Graphnosis: the
// nodes, scores, ids and content come out of the SDK, and S-04 (withheld
// engrams missing from the audit) was found here and nowhere else.
//
// The fixture is built by the conformance harness in the whitepaper repo and is
// NOT vendored here — it is ~16 MiB of `.gai`. These tests skip cleanly when it
// is absent, so the package's suite stays runnable standalone. Point
// MOCK_CORTEX_RUNNER at `conformance/mock-cortex/runner.mjs` to run them from a
// non-default checkout layout.
//
// Run: node --loader ./test/_sodium-resolve.mjs --test test/federation-cortex.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { federatedQuery, contentFingerprint } from '../dist/federation/index.js';

const RUNNER_URL = process.env.MOCK_CORTEX_RUNNER
  ? new URL(`file://${process.env.MOCK_CORTEX_RUNNER}`)
  : new URL('../../graphnosis-whitepaper/conformance/mock-cortex/runner.mjs', import.meta.url);

const available = existsSync(fileURLToPath(RUNNER_URL));
const skip = available ? false : `mock cortex fixture not found at ${fileURLToPath(RUNNER_URL)}`;

/** The seven real engrams. The corrupt and phantom ids in policy.json are exercised elsewhere. */
const REAL_ENGRAMS = [
  'archived-2019', 'clinic-records', 'field-notes', 'laptop-mirror',
  'personal-journal', 'session-log', 'work-notes',
];

let cortex;
async function fixture() {
  if (cortex) return cortex;
  const { createMockCortexRunner, loadPolicy, loadManifest } = await import(RUNNER_URL.href);
  const manifest = loadManifest();
  cortex = { runner: createMockCortexRunner({ manifest }), policy: loadPolicy(), manifest };
  return cortex;
}

const auditFor = (sub, graphId) => sub.audit.find(a => a.graphId === graphId);
const withheldFor = (sub, graphId) => sub.withheld.find(a => a.graphId === graphId);
const allTexts = sub => [...sub.byGraph.values()].flat().map(n => n.text);
const contextOf = sub => (sub.complete ? sub.prompt : sub.partialPrompt);

// --- S-04 ---------------------------------------------------------------------

test('every requested engram is accounted for, including the withheld ones', { skip }, async () => {
  const { runner, policy } = await fixture();
  const sub = await federatedQuery(runner, REAL_ENGRAMS, 'field work notes', policy);

  // Pre-fix this returned 5 rows for 7 requested engrams: `clinic-records` and
  // `archived-2019` were absent entirely, indistinguishable from never having
  // been asked for. They are accounted for now — but in `withheld`, not in the
  // array a caller counts.
  assert.deepEqual(
    [...sub.audit, ...sub.withheld].map(a => a.graphId).sort(),
    [...REAL_ENGRAMS].sort(),
  );
  assert.equal(sub.audit.length, 5, '`audit.length` is the number of engrams ASKED');
  assert.equal(sub.withheld.length, 2);
  assert.equal(sub.audit.some(a => a.status === 'withheld'), false);
});

test('the two withheld engrams state WHICH rule withheld them', { skip }, async () => {
  const { runner, policy } = await fixture();
  const sub = await federatedQuery(runner, REAL_ENGRAMS, 'field work notes', policy);

  // sensitive tier, despite shareWithAi:true — proves the backstop, not the flag.
  const clinic = withheldFor(sub, 'clinic-records');
  assert.equal(clinic.status, 'withheld');
  assert.equal(clinic.reason, 'sensitive-tier');
  assert.equal(clinic.tier, 'sensitive');

  // public tier, shareWithAi:false — isolates the share filter from the tier backstop.
  const archived = withheldFor(sub, 'archived-2019');
  assert.equal(archived.status, 'withheld');
  assert.equal(archived.reason, 'sharing-disabled');
  assert.equal(archived.tier, 'public');
});

test('withheld engrams contribute nothing and are never named to the model', { skip }, async () => {
  const { runner, policy } = await fixture();
  const sub = await federatedQuery(runner, REAL_ENGRAMS, 'field work notes', policy);

  assert.equal(sub.byGraph.has('clinic-records'), false);
  assert.equal(sub.byGraph.has('archived-2019'), false);
  assert.doesNotMatch(contextOf(sub), /clinic-records/);
  assert.doesNotMatch(contextOf(sub), /archived-2019/);
  // Withholding is not incompleteness: everything that should have been read was.
  assert.equal(sub.complete, true);
});

// `clinic-records` holds T1 incident+policy material, so this query genuinely
// matches it — which is what makes the withheld row's silence meaningful.
const CLINIC_QUERY = 'incident response policy';

test('a withheld row exposes nothing about what the engram holds', { skip }, async () => {
  const { runner, policy } = await fixture();
  const sub = await federatedQuery(runner, REAL_ENGRAMS, CLINIC_QUERY, policy);

  // Consented, this same query pulls clinic-records' full 5-node cap (below).
  // Withheld, the row must not hint that there was anything to find.
  const clinic = withheldFor(sub, 'clinic-records');
  assert.equal(clinic.status, 'withheld');
  assert.deepEqual(Object.keys(clinic).sort(), ['graphId', 'reason', 'status', 'tier']);
});

test('naming the sensitive engram in allowGraphIds queries it, clamped to its tier cap', { skip }, async () => {
  const { runner, policy } = await fixture();
  const sub = await federatedQuery(
    runner, REAL_ENGRAMS, CLINIC_QUERY, policy, undefined, ['clinic-records'],
  );

  const clinic = auditFor(sub, 'clinic-records');
  assert.equal(clinic.status, 'ok');
  assert.ok(clinic.nodesIncluded > 0, 'a consented sensitive engram must actually contribute');
  assert.ok(clinic.nodesIncluded <= 5, 'sensitive cap: ≤ 5 nodes');
  assert.ok(clinic.tokensIncluded <= 500, 'sensitive cap: ≤ 500 tokens');
  // archived-2019 is unaffected by consent to a different engram.
  assert.equal(withheldFor(sub, 'archived-2019').status, 'withheld');
});

// --- Dedup and collision safety on real content -------------------------------

test('the mirrored engram’s duplicates collapse, and the lower tier keeps the copy', { skip }, async () => {
  const { runner, policy, manifest } = await fixture();
  const { originEngram, mirrorEngram } = manifest.duplication;
  // laptop-mirror re-ingests personal-journal's documents: same bytes, different
  // provenance — a note synced between two devices.
  const sub = await federatedQuery(
    runner, [originEngram, mirrorEngram], 'heritage music journal', policy,
    { maxTokens: 4_000, maxNodes: 30, perGraphMinTokens: 0 },
  );

  const texts = allTexts(sub);
  assert.equal(new Set(texts).size, texts.length, 'no content may appear twice in one context');
  assert.equal(texts.length, sub.nodesIncluded);

  // Dedup's tier rule with a visible consequence: the mirror is `public`, the
  // journal `personal`, so the mirror's copy survives and the drop is charged
  // to the journal — the scarcer budget is left for distinct evidence.
  assert.ok(auditFor(sub, originEngram).duplicatesDropped > 0);
  assert.equal(auditFor(sub, mirrorEngram).duplicatesDropped, 0);
});

test('a REAL 32-bit hash collision keeps both memories', { skip }, async () => {
  const { runner, policy, manifest } = await fixture();
  const { a, b, engram, substitutedWord } = { ...manifest.collision, substitutedWord: undefined };

  // Same fingerprint, different content — the only input that can tell a correct
  // dedup from one that drops on a bare hash match.
  assert.equal(contentFingerprint(a.text), contentFingerprint(b.text));
  assert.notEqual(a.text, b.text);

  const sub = await federatedQuery(
    runner, [engram], `${a.substitutedWord} ${b.substitutedWord} runbook rewrite`, policy,
    { maxTokens: 8_000, maxNodes: 40, perGraphMinTokens: 0 },
  );

  const texts = allTexts(sub);
  assert.ok(texts.includes(a.text), 'collision half A was dropped');
  assert.ok(texts.includes(b.text), 'collision half B was dropped');
});

// --- Failure and timeout over real engrams ------------------------------------

test('a corrupt engram degrades to a failed row while the rest answer', { skip }, async () => {
  const { policy, manifest } = await fixture();
  const { createMockCortexRunner } = await import(RUNNER_URL.href);
  // The `.gai` under corrupt/ makes the SDK throw on load; federation turns the
  // throw into a failure row instead of losing the whole recall.
  const corrupt = manifest.corruptions[0].id;
  const runner = createMockCortexRunner({ manifest });
  const sub = await federatedQuery(runner, [corrupt, 'work-notes', 'field-notes'], 'field work notes', policy);

  assert.equal(sub.complete, false);
  assert.deepEqual(sub.failures.map(f => f.graphId), [corrupt]);
  assert.equal(sub.failures[0].reason, 'error');
  assert.ok(sub.nodesIncluded > 0, 'the healthy engrams still answered');
  assert.match(contextOf(sub), /INCOMPLETE CONTEXT/);
});

test('a phantom (never-settling) engram times out without stalling the others', { skip }, async () => {
  const { policy, manifest } = await fixture();
  const { createMockCortexRunner } = await import(RUNNER_URL.href);
  const phantom = manifest.phantomEngrams[0].id; // hangs by default in the runner
  const runner = createMockCortexRunner({ manifest });

  const started = Date.now();
  const sub = await federatedQuery(
    runner, [phantom, 'work-notes'], 'field work notes', policy, undefined, undefined, { timeoutMs: 250 },
  );
  assert.ok(Date.now() - started < 10_000);
  assert.equal(sub.failures.find(f => f.graphId === phantom).reason, 'timeout');
  assert.ok(sub.nodesIncluded > 0);
});
