// Federation: per-graph failure tolerance, per-graph timeout, and content dedup
// before budgeting.
//
// Three shipped bugs are pinned here:
//   1. `Promise.all` over the per-graph queries — one failing engram rejected
//      the ENTIRE federated recall, so the user got nothing instead of the
//      answers from every engram that worked.
//   2. No timeout — an engram that HANGS (stalled mount, lock held forever)
//      never settled, so the whole recall waited indefinitely.
//   3. No dedup of any kind — the same memory living in two engrams was paid
//      for twice out of one token budget, displacing distinct evidence.
// Plus the collision trap the SDK fell into: dedup keyed on a 32-bit hash alone
// silently drops a DIFFERENT memory that happens to collide.
//
// The result is a discriminated union on `complete`, so a consumer cannot reach
// a renderable prompt without confronting the gap. The compile-time half of
// that guarantee is verified by a tsc probe, not by this file — see the report.
//
// Run: node --loader ./test/_sodium-resolve.mjs --test test/federation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  federatedQuery,
  federationFailures,
  contentFingerprint,
  resolveTimeoutMs,
} from '../dist/federation/index.js';
import { DEFAULT_BUDGET } from '../dist/policy/index.js';

/**
 * spec: { [graphId]: { nodes?: [{nodeId, score, text}], error?: Error, delay?: number, hang?: true } }
 * `delay` exists to shuffle promise-settlement order — determinism must not
 * depend on which engram answers first. `hang` never settles at all.
 */
function runnerFrom(spec) {
  return {
    async runQuery(graphId) {
      const entry = spec[graphId];
      if (!entry) return [];
      if (entry.hang) await new Promise(() => {});
      if (entry.delay) await new Promise(r => setTimeout(r, entry.delay));
      if (entry.error) throw entry.error;
      return (entry.nodes ?? []).map(n => ({ graphId, ...n }));
    },
  };
}

/** A runner whose per-graph calls are serialized through one chain, like the sidecar's ONNX queue. */
function serializedRunnerFrom(spec) {
  const inner = runnerFrom(spec);
  let chain = Promise.resolve();
  return {
    runQuery(graphId, query, k) {
      const mine = chain.then(() => inner.runQuery(graphId, query, k));
      chain = mine.then(() => undefined, () => undefined);
      return mine;
    },
  };
}

const cfgOf = (...graphs) => ({ defaultBudget: DEFAULT_BUDGET, graphs });

const allTexts = sub => [...sub.byGraph.values()].flat().map(n => n.text).sort();
const auditFor = (sub, graphId) => sub.audit.find(a => a.graphId === graphId);
const withheldFor = (sub, graphId) => sub.withheld.find(a => a.graphId === graphId);
/** The rendered context, whichever branch it came from. */
const contextOf = sub => (sub.complete ? sub.prompt : sub.partialPrompt);

// --- GAP 1: one failing engram must not cost the others their results --------

test('a failing engram still yields the other engrams’ results', async () => {
  const runner = runnerFrom({
    broken: { error: new Error('sqlite: database is locked') },
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'ship the release notes' }] },
  });
  const sub = await federatedQuery(runner, ['broken', 'notes'], 'release', cfgOf());

  assert.equal(sub.nodesIncluded, 1);
  assert.deepEqual(allTexts(sub), ['ship the release notes']);
  assert.equal(sub.byGraph.has('broken'), false);
});

test('incompleteness is on the result type, not just in a field', async () => {
  const runner = runnerFrom({
    broken: { error: new Error('sqlite: database is locked') },
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'ship the release notes' }] },
  });
  const sub = await federatedQuery(runner, ['broken', 'notes'], 'release', cfgOf());

  assert.equal(sub.complete, false);
  // The complete branch's `prompt` does not exist here: reaching a renderable
  // context off an incomplete result means naming it as partial.
  assert.equal(sub.prompt, undefined);
  assert.equal(typeof sub.partialPrompt, 'string');

  assert.deepEqual(sub.failures.map(f => f.graphId), ['broken']);
  assert.equal(sub.failures[0].reason, 'error');
  assert.equal(sub.failures[0].tier, 'personal');
  assert.match(sub.failures[0].error, /database is locked/);
  assert.deepEqual(federationFailures(sub), sub.failures);
});

test('a failed engram is distinguishable from an engram with no matches', async () => {
  const runner = runnerFrom({
    broken: { error: new Error('sqlite: database is locked') },
    empty: { nodes: [] },
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'ship the release notes' }] },
  });
  const sub = await federatedQuery(runner, ['broken', 'empty', 'notes'], 'release', cfgOf());

  assert.equal(auditFor(sub, 'broken').status, 'failed');
  assert.equal(auditFor(sub, 'empty').status, 'ok');
  assert.equal(auditFor(sub, 'empty').error, undefined);
  // The engram with no matches reports a real zero. The failed one reports NO
  // count at all: a zero there would read as "no matching memory", which is the
  // false negative this release exists to remove.
  assert.equal(auditFor(sub, 'empty').nodesIncluded, 0);
  assert.equal(auditFor(sub, 'broken').nodesIncluded, undefined);
  assert.equal(auditFor(sub, 'broken').tokensIncluded, undefined);
  assert.match(auditFor(sub, 'broken').error, /database is locked/);

  // Second line of defence: the renderer discloses the gap to the model.
  assert.match(contextOf(sub), /INCOMPLETE CONTEXT/);
  assert.match(contextOf(sub), /broken/);
});

test('a clean recall is `complete: true` with no banner', async () => {
  const runner = runnerFrom({ notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'all good' }] } });
  const sub = await federatedQuery(runner, ['notes'], 'q', cfgOf());

  assert.equal(sub.complete, true);
  assert.deepEqual(federationFailures(sub), []);
  assert.equal(sub.failures, undefined);
  assert.doesNotMatch(sub.prompt, /INCOMPLETE CONTEXT/);
});

test('a failure does not reject the recall (regression: Promise.all)', async () => {
  const runner = runnerFrom({
    a: { error: new Error('boom') },
    b: { error: new Error('boom too') },
    c: { nodes: [{ nodeId: 'n1', score: 0.5, text: 'survivor' }] },
  });
  await assert.doesNotReject(() => federatedQuery(runner, ['a', 'b', 'c'], 'q', cfgOf()));

  const sub = await federatedQuery(runner, ['a', 'b', 'c'], 'q', cfgOf());
  assert.equal(sub.nodesIncluded, 1);
  assert.equal(sub.failures.length, 2);
});

test('a failing consented SENSITIVE engram keeps the partial evidence AND flags its tier', async () => {
  const cfg = cfgOf(
    { graphId: 'health', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'notes', shareWithAi: true, tier: 'personal' },
  );
  const runner = runnerFrom({
    health: { error: new Error('decrypt failed') },
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'dentist on tuesday' }] },
  });
  const sub = await federatedQuery(runner, ['health', 'notes'], 'q', cfg, DEFAULT_BUDGET, ['health']);

  // Nothing is thrown and nothing is discarded — the engram that answered is here.
  assert.equal(sub.complete, false);
  assert.deepEqual(allTexts(sub), ['dentist on tuesday']);
  // ...and a caller can apply a stricter rule to the consented-sensitive case
  // without re-deriving the tier from policy.
  const sensitive = sub.failures.filter(f => f.tier === 'sensitive');
  assert.deepEqual(sensitive.map(f => f.graphId), ['health']);
  assert.match(sensitive[0].error, /decrypt failed/);
  assert.equal(auditFor(sub, 'health').status, 'failed');
});

test('a failing sensitive engram that was never consented cannot affect the recall', async () => {
  // Not in allowGraphIds ⇒ filtered out before any query runs.
  const cfg = cfgOf({ graphId: 'health', shareWithAi: true, tier: 'sensitive' });
  const runner = runnerFrom({
    health: { error: new Error('should never be queried') },
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'kept' }] },
  });
  const sub = await federatedQuery(runner, ['health', 'notes'], 'q', cfg);

  // Withholding is not a failure: the recall is complete, because every engram
  // that was supposed to be read was read.
  assert.equal(sub.complete, true);
  assert.deepEqual(allTexts(sub), ['kept']);
  assert.equal(withheldFor(sub, 'health').status, 'withheld');
});

// --- S-04: withheld engrams must appear in the audit -------------------------

test('an engram withheld by TIER gets a row saying so', async () => {
  const cfg = cfgOf(
    { graphId: 'clinic-records', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'work-notes', shareWithAi: true, tier: 'public' },
  );
  const runner = runnerFrom({ 'work-notes': { nodes: [{ nodeId: 'n1', score: 0.9, text: 'standup at ten' }] } });
  const sub = await federatedQuery(runner, ['clinic-records', 'work-notes'], 'q', cfg);

  const row = withheldFor(sub, 'clinic-records');
  assert.ok(row, 'the row that proves the guarantee fired must not be the row the audit drops');
  assert.equal(row.status, 'withheld');
  assert.equal(row.reason, 'sensitive-tier');
  assert.equal(row.tier, 'sensitive');
});

test('an engram withheld by the shareWithAi FLAG gets a different reason', async () => {
  const cfg = cfgOf(
    { graphId: 'archived-2019', shareWithAi: false, tier: 'public' },
    { graphId: 'work-notes', shareWithAi: true, tier: 'public' },
  );
  const runner = runnerFrom({ 'work-notes': { nodes: [{ nodeId: 'n1', score: 0.9, text: 'standup at ten' }] } });
  const sub = await federatedQuery(runner, ['archived-2019', 'work-notes'], 'q', cfg);

  const row = withheldFor(sub, 'archived-2019');
  assert.equal(row.status, 'withheld');
  // Tier and flag are different facts; a consent screen wants to say which one.
  assert.equal(row.reason, 'sharing-disabled');
});

test('tier outranks the flag when both would withhold', async () => {
  const cfg = cfgOf({ graphId: 'both', shareWithAi: false, tier: 'sensitive' });
  const sub = await federatedQuery(runnerFrom({}), ['both'], 'q', cfg);
  assert.equal(withheldFor(sub, 'both').reason, 'sensitive-tier');
});

test('a WITHHELD engram is distinguishable from one that matched nothing', async () => {
  const cfg = cfgOf(
    { graphId: 'clinic-records', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'work-notes', shareWithAi: true, tier: 'public' },
  );
  // work-notes is queried and legitimately returns nothing.
  const runner = runnerFrom({ 'work-notes': { nodes: [] } });
  const sub = await federatedQuery(runner, ['clinic-records', 'work-notes'], 'q', cfg);

  const withheld = withheldFor(sub, 'clinic-records');
  const empty = auditFor(sub, 'work-notes');
  assert.equal(withheld.status, 'withheld');
  assert.equal(empty.status, 'ok');
  assert.equal(empty.nodesIncluded, 0);
  // The old shape could not tell these apart at all: one row was simply absent.
  assert.notEqual(withheld.status, empty.status);
});

test('a withheld row carries no counts — the audit is not a side channel', async () => {
  const cfg = cfgOf({ graphId: 'clinic-records', shareWithAi: true, tier: 'sensitive' });
  const sub = await federatedQuery(runnerFrom({}), ['clinic-records'], 'q', cfg);

  const row = withheldFor(sub, 'clinic-records');
  assert.deepEqual(Object.keys(row).sort(), ['graphId', 'reason', 'status', 'tier']);
  // Nothing that could let a caller infer what the engram holds.
  for (const leak of ['nodesIncluded', 'tokensIncluded', 'duplicatesDropped', 'nodesMatched', 'error']) {
    assert.equal(row[leak], undefined, `withheld row must not carry ${leak}`);
  }
});

test('a consented sensitive engram is queried, not withheld', async () => {
  const cfg = cfgOf({ graphId: 'clinic-records', shareWithAi: true, tier: 'sensitive' });
  const runner = runnerFrom({ 'clinic-records': { nodes: [{ nodeId: 'n1', score: 0.9, text: 'bp reading' }] } });
  const sub = await federatedQuery(runner, ['clinic-records'], 'q', cfg, DEFAULT_BUDGET, ['clinic-records']);

  assert.equal(auditFor(sub, 'clinic-records').status, 'ok');
  assert.equal(auditFor(sub, 'clinic-records').nodesIncluded, 1);
});

test('the withheld engram is never named to the model', async () => {
  const cfg = cfgOf(
    { graphId: 'clinic-records', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'broken', shareWithAi: true, tier: 'personal' },
    { graphId: 'work-notes', shareWithAi: true, tier: 'public' },
  );
  const runner = runnerFrom({
    broken: { error: new Error('disk') },
    'work-notes': { nodes: [{ nodeId: 'n1', score: 0.9, text: 'standup at ten' }] },
  });
  const sub = await federatedQuery(runner, ['clinic-records', 'broken', 'work-notes'], 'q', cfg);

  // The failed engram is disclosed to the model; the withheld one is not —
  // naming it would tell the AI a sensitive engram exists and was in scope.
  assert.match(contextOf(sub), /INCOMPLETE CONTEXT/);
  assert.match(contextOf(sub), /broken/);
  assert.doesNotMatch(contextOf(sub), /clinic-records/);
  // The caller still sees it.
  assert.equal(withheldFor(sub, 'clinic-records').status, 'withheld');
});

test('the audit has exactly one row per requested engram, in request order', async () => {
  const cfg = cfgOf(
    { graphId: 'a-public', shareWithAi: true, tier: 'public' },
    { graphId: 'b-sensitive', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'c-off', shareWithAi: false, tier: 'personal' },
  );
  const runner = runnerFrom({ 'a-public': { nodes: [{ nodeId: 'n1', score: 0.9, text: 'x' }] } });
  const requested = ['a-public', 'b-sensitive', 'c-off', 'd-unlisted'];
  const sub = await federatedQuery(runner, requested, 'q', cfg);

  // `audit` covers the engrams ASKED, in request order; the withheld ones are
  // accounted for in full, in their own array, also in request order.
  assert.deepEqual(sub.audit.map(a => a.graphId), ['a-public', 'd-unlisted']);
  assert.deepEqual(sub.audit.map(a => a.status), ['ok', 'ok']);
  assert.deepEqual(sub.withheld.map(a => a.graphId), ['b-sensitive', 'c-off']);
  assert.deepEqual(sub.withheld.map(a => a.status), ['withheld', 'withheld']);
  // Every requested engram is accounted for exactly once, across the two.
  assert.deepEqual([...sub.audit, ...sub.withheld].map(a => a.graphId).sort(), [...requested].sort());
});

// --- S-04b: the count channel ------------------------------------------------
// Refusing to put counts ON a withheld row does not close the channel if the row
// still lands in the array a caller COUNTS. This is the regression that made the
// merge worse than the omission it fixed, and it was invisible to the compiler:
// `sub.audit.length` typechecks identically either way.

test('a withheld engram does not move `audit.length` — the count is not a side channel', async () => {
  const cfg = cfgOf(
    { graphId: 'work-notes', shareWithAi: true, tier: 'public' },
    { graphId: 'clinic-records', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'archived-2019', shareWithAi: false, tier: 'personal' },
  );
  const runner = runnerFrom({ 'work-notes': { nodes: [{ nodeId: 'n1', score: 0.9, text: 'standup at ten' }] } });

  const withSensitive = await federatedQuery(runner, ['work-notes', 'clinic-records', 'archived-2019'], 'q', cfg);
  const withoutSensitive = await federatedQuery(runner, ['work-notes'], 'q', cfg);

  // The desktop app derives "(N other engram(s) searched, no matches.)" — text
  // that goes to the MODEL — from exactly this subtraction. If a withheld
  // engram lands in `audit`, N grows and the model learns how many engrams the
  // user is hiding. It must be identical whether or not they are in scope.
  const skipped = sub => sub.audit.length - sub.audit.filter(a => a.status === 'ok' && a.nodesIncluded > 0).length;
  assert.equal(skipped(withSensitive), skipped(withoutSensitive));
  assert.equal(withSensitive.audit.length, withoutSensitive.audit.length);
  assert.equal(withSensitive.audit.length, 1, '`audit.length` is the number of engrams ASKED');
  // Nothing withheld is reachable from the array a caller aggregates.
  assert.equal(withSensitive.audit.some(a => a.status === 'withheld'), false);
  assert.deepEqual(withSensitive.withheld.map(a => a.graphId), ['clinic-records', 'archived-2019']);
});

test('a failed engram is not summed into "searched, no matches"', async () => {
  const runner = runnerFrom({
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'kept' }] },
    broken: { error: new Error('sqlite: database is locked') },
  });
  const sub = await federatedQuery(runner, ['notes', 'broken'], 'q', cfgOf());

  // `nodesIncluded` does not exist on the failed row, so the naive filter that
  // produced the miscount cannot be written against it in TypeScript at all.
  assert.equal(auditFor(sub, 'broken').nodesIncluded, undefined);
  const answeredNothing = sub.audit.filter(a => a.status === 'ok' && a.nodesIncluded === 0);
  assert.deepEqual(answeredNothing, [], 'a failed engram must never appear as "searched, no matches"');
  assert.equal(sub.complete, false);
});

// --- Per-graph timeout -------------------------------------------------------

test('a hung engram times out instead of stalling the recall forever', async () => {
  const runner = runnerFrom({
    stalled: { hang: true },
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'still delivered' }] },
  });
  const started = Date.now();
  const sub = await federatedQuery(runner, ['stalled', 'notes'], 'q', cfgOf(), DEFAULT_BUDGET, undefined, { timeoutMs: 60 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `recall should end on the timeout, took ${elapsed}ms`);
  assert.deepEqual(allTexts(sub), ['still delivered'], 'the healthy engram is not held hostage');
  assert.equal(sub.complete, false);
  assert.equal(sub.failures.length, 1);
  assert.equal(sub.failures[0].graphId, 'stalled');
  assert.equal(sub.failures[0].reason, 'timeout');
  assert.match(sub.failures[0].error, /timed out after 60ms/);
  assert.equal(auditFor(sub, 'stalled').status, 'failed');
  assert.match(auditFor(sub, 'stalled').error, /timed out/);
});

test('a timeout is reported as a timeout, not as an error', async () => {
  const runner = runnerFrom({ stalled: { hang: true }, broken: { error: new Error('nope') } });
  const sub = await federatedQuery(runner, ['stalled', 'broken'], 'q', cfgOf(), DEFAULT_BUDGET, undefined, { timeoutMs: 40 });

  const byId = Object.fromEntries(sub.failures.map(f => [f.graphId, f.reason]));
  assert.deepEqual(byId, { stalled: 'timeout', broken: 'error' });
});

test('a slow-but-healthy engram waiting behind a queue is NOT killed', async () => {
  // The sidecar serializes ONNX, so engram #3 legitimately starts late. Timing
  // from dispatch must not punish it.
  const runner = serializedRunnerFrom({
    a: { delay: 60, nodes: [{ nodeId: 'n1', score: 0.9, text: 'from a' }] },
    b: { delay: 60, nodes: [{ nodeId: 'n1', score: 0.8, text: 'from b' }] },
    c: { delay: 60, nodes: [{ nodeId: 'n1', score: 0.7, text: 'from c' }] },
  });
  // c cannot start until ~120ms in, and finishes ~180ms in — inside a 400ms allowance.
  const sub = await federatedQuery(runner, ['a', 'b', 'c'], 'q', cfgOf(), DEFAULT_BUDGET, undefined, { timeoutMs: 400 });

  assert.equal(sub.complete, true, 'no healthy engram may be timed out for queue wait');
  assert.deepEqual(allTexts(sub), ['from a', 'from b', 'from c']);
});

test('the default allowance grows with the number of engrams in scope', () => {
  // The clock starts at dispatch (federation cannot observe when a queued call
  // actually begins), so the default must absorb the queue ahead of an engram.
  assert.equal(resolveTimeoutMs(1), 15_000);
  assert.equal(resolveTimeoutMs(3), 25_000);
  assert.ok(resolveTimeoutMs(12) > resolveTimeoutMs(4));
});

test('the default allowance is generous enough for an ordinary slow read', async () => {
  const runner = runnerFrom({ slow: { delay: 250, nodes: [{ nodeId: 'n1', score: 0.9, text: 'late but fine' }] } });
  const sub = await federatedQuery(runner, ['slow'], 'q', cfgOf());
  assert.equal(sub.complete, true);
  assert.deepEqual(allTexts(sub), ['late but fine']);
});

// --- GAP 2: content dedup before budgeting -----------------------------------

test('the same memory in two engrams is counted once', async () => {
  const runner = runnerFrom({
    laptop: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'passport expires in March' }] },
    phone: { nodes: [{ nodeId: 'n7', score: 0.9, text: 'passport expires in March' }] },
  });
  const sub = await federatedQuery(runner, ['laptop', 'phone'], 'passport', cfgOf());

  assert.equal(sub.nodesIncluded, 1);
  assert.deepEqual(allTexts(sub), ['passport expires in March']);
});

test('whitespace-only differences are the same memory', async () => {
  const runner = runnerFrom({
    laptop: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'passport expires in March' }] },
    phone: { nodes: [{ nodeId: 'n7', score: 0.9, text: '  passport   expires in\nMarch  ' }] },
  });
  const sub = await federatedQuery(runner, ['laptop', 'phone'], 'passport', cfgOf());
  assert.equal(sub.nodesIncluded, 1);
});

test('dedup is recorded in the audit of the engram that lost the copy', async () => {
  const runner = runnerFrom({
    laptop: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'passport expires in March' }] },
    phone: { nodes: [{ nodeId: 'n7', score: 0.9, text: 'passport expires in March' }] },
  });
  const sub = await federatedQuery(runner, ['laptop', 'phone'], 'passport', cfgOf());

  assert.equal(auditFor(sub, 'laptop').nodesIncluded, 1);
  assert.equal(auditFor(sub, 'laptop').duplicatesDropped, 0);
  // phone matched the memory but contributed nothing — the audit says why.
  assert.equal(auditFor(sub, 'phone').nodesIncluded, 0);
  assert.equal(auditFor(sub, 'phone').duplicatesDropped, 1);
});

test('which copy survives is deterministic, whatever order the engrams answer in', async () => {
  const nodes = text => ([{ nodeId: 'x', score: 0.9, text }]);
  const fast = { laptop: { nodes: nodes('passport expires in March'), delay: 0 },
                 phone: { nodes: nodes('passport expires in March'), delay: 20 } };
  const slow = { laptop: { nodes: nodes('passport expires in March'), delay: 20 },
                 phone: { nodes: nodes('passport expires in March'), delay: 0 } };

  const a = await federatedQuery(runnerFrom(fast), ['laptop', 'phone'], 'q', cfgOf());
  const b = await federatedQuery(runnerFrom(slow), ['laptop', 'phone'], 'q', cfgOf());

  assert.deepEqual([...a.byGraph.keys()], [...b.byGraph.keys()]);
  assert.equal(contextOf(a), contextOf(b));
  // Tie on score ⇒ the existing (graphId, nodeId) tie-break decides: 'laptop' < 'phone'.
  assert.deepEqual([...a.byGraph.keys()], ['laptop']);
});

test('the deterministic tie-break across engrams still holds (no reorder by settle order)', async () => {
  const spec = (dA, dB) => ({
    'b-graph': { nodes: [{ nodeId: 'n1', score: 0.5, text: 'from b' }], delay: dB },
    'a-graph': { nodes: [{ nodeId: 'n1', score: 0.5, text: 'from a' }], delay: dA },
  });
  const first = sub => [...sub.byGraph.keys()][0];

  const aFirst = await federatedQuery(runnerFrom(spec(0, 20)), ['b-graph', 'a-graph'], 'q', cfgOf());
  const bFirst = await federatedQuery(runnerFrom(spec(20, 0)), ['b-graph', 'a-graph'], 'q', cfgOf());

  assert.equal(first(aFirst), 'a-graph');
  assert.equal(first(bFirst), 'a-graph');
  assert.equal(contextOf(aFirst), contextOf(bFirst));
});

test('a hash collision with DIFFERENT content keeps BOTH memories', async () => {
  // Real 32-bit DJB2 collision (…Bb / …CA differ by +1/-33 in adjacent chars).
  const a = 'Quarterly numbers Bb';
  const b = 'Quarterly numbers CA';
  assert.equal(contentFingerprint(a), contentFingerprint(b), 'test fixture must actually collide');
  assert.notEqual(a, b);

  const runner = runnerFrom({
    work: { nodes: [{ nodeId: 'n1', score: 0.9, text: a }] },
    archive: { nodes: [{ nodeId: 'n2', score: 0.8, text: b }] },
  });
  const sub = await federatedQuery(runner, ['work', 'archive'], 'q', cfgOf());

  assert.equal(sub.nodesIncluded, 2, 'a hash collision is not a duplicate — no evidence may be dropped');
  assert.deepEqual(allTexts(sub), [a, b].sort());
  assert.equal(auditFor(sub, 'archive').duplicatesDropped, 0);
});

test('a collision in the same bucket does not stop a real duplicate being dropped', async () => {
  const a = 'Quarterly numbers Bb';
  const b = 'Quarterly numbers CA';
  const runner = runnerFrom({
    work: { nodes: [{ nodeId: 'n1', score: 0.9, text: a }] },
    archive: { nodes: [{ nodeId: 'n2', score: 0.8, text: b }] },
    backup: { nodes: [{ nodeId: 'n3', score: 0.7, text: b }] }, // true duplicate of b
  });
  const sub = await federatedQuery(runner, ['work', 'archive', 'backup'], 'q', cfgOf());

  assert.equal(sub.nodesIncluded, 2);
  assert.equal(auditFor(sub, 'backup').duplicatesDropped, 1);
});

test('dedup happens before budgeting, so the budget buys distinct evidence', async () => {
  const budget = { maxTokens: 10_000, maxNodes: 2, perGraphMinTokens: 0 };
  const runner = runnerFrom({
    laptop: {
      nodes: [
        { nodeId: 'n1', score: 0.9, text: 'passport expires in March' },
        { nodeId: 'n2', score: 0.5, text: 'renew the car insurance' },
      ],
    },
    phone: {
      nodes: [
        { nodeId: 'n7', score: 0.9, text: 'passport expires in March' },
        { nodeId: 'n8', score: 0.4, text: 'dentist on tuesday' },
      ],
    },
  });
  const sub = await federatedQuery(runner, ['laptop', 'phone'], 'q', cfgOf(), budget);

  // Pre-fix, both budget slots went to the two copies of the same memory.
  assert.equal(sub.nodesIncluded, 2);
  assert.deepEqual(allTexts(sub), ['passport expires in March', 'renew the car insurance']);
});

test('a duplicate is not charged to the sensitive engram’s cap when a public copy exists', async () => {
  const cfg = cfgOf(
    { graphId: 'health', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'notes', shareWithAi: true, tier: 'public' },
  );
  const runner = runnerFrom({
    health: { nodes: [{ nodeId: 'h1', score: 0.9, text: 'appointment on friday' }] },
    notes: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'appointment on friday' }] },
  });
  const sub = await federatedQuery(runner, ['health', 'notes'], 'q', cfg, DEFAULT_BUDGET, ['health']);

  assert.equal(sub.nodesIncluded, 1);
  assert.equal(auditFor(sub, 'notes').nodesIncluded, 1, 'the public copy is the one that survives');
  assert.equal(auditFor(sub, 'health').nodesIncluded, 0);
  assert.equal(auditFor(sub, 'health').duplicatesDropped, 1);
  assert.equal(auditFor(sub, 'health').tokensIncluded, 0, 'the sensitive cap is left for distinct evidence');
});

test('redacted nodes never win a dedup slot from a non-redacted copy', async () => {
  const cfg = cfgOf({ graphId: 'laptop', shareWithAi: true, excludeTags: ['private'] });
  const runner = runnerFrom({
    laptop: { nodes: [{ nodeId: 'n1', score: 0.9, text: 'shared memory', tags: ['private'] }] },
    phone: { nodes: [{ nodeId: 'n7', score: 0.5, text: 'shared memory' }] },
  });
  const sub = await federatedQuery(runner, ['laptop', 'phone'], 'q', cfg);

  assert.equal(sub.nodesIncluded, 1);
  assert.deepEqual([...sub.byGraph.keys()], ['phone']);
});
