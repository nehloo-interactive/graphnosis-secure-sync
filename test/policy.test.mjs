// Finding #11: a sensitive-tier engram must never be federated, even if a
// policy decouples tier from shareWithAi and sets shareWithAi:true.
// Run: node --loader ./test/_sodium-resolve.mjs --test test/policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShare, shareableGraphs, DEFAULT_BUDGET } from '../dist/policy/index.js';

const cfg = {
  defaultBudget: DEFAULT_BUDGET,
  graphs: [
    { graphId: 'public-notes', shareWithAi: true, tier: 'public' },
    { graphId: 'personal-misc', shareWithAi: true, tier: 'personal' },
    // The dangerous decoupling: sensitive tier but shareWithAi flipped on.
    { graphId: 'secrets', shareWithAi: true, tier: 'sensitive' },
  ],
};

test('sensitive engram is never shareable even with shareWithAi:true', () => {
  assert.equal(shouldShare(cfg, 'secrets'), false);
});

test('non-sensitive engrams still honor shareWithAi', () => {
  assert.equal(shouldShare(cfg, 'public-notes'), true);
  assert.equal(shouldShare(cfg, 'personal-misc'), true);
});

test('shareableGraphs excludes the sensitive engram', () => {
  const out = shareableGraphs(cfg, ['public-notes', 'personal-misc', 'secrets']);
  assert.deepEqual(out.sort(), ['personal-misc', 'public-notes']);
});

test('allowGraphIds lets an explicitly-consented sensitive engram through', () => {
  // The app passes this after its per-engram consent gate approves an
  // explicitly-named sensitive engram. The tier cap (applied elsewhere) still
  // clamps how much it can contribute.
  const out = shareableGraphs(cfg, ['public-notes', 'secrets'], ['secrets']);
  assert.deepEqual(out.sort(), ['public-notes', 'secrets']);
});

test('allowGraphIds only affects listed engrams (others still gated)', () => {
  const cfg2 = { defaultBudget: DEFAULT_BUDGET, graphs: [
    { graphId: 'health', shareWithAi: true, tier: 'sensitive' },
    { graphId: 'finances', shareWithAi: true, tier: 'sensitive' },
  ]};
  const out = shareableGraphs(cfg2, ['health', 'finances'], ['health']);
  assert.deepEqual(out, ['health']); // finances stays excluded
});
