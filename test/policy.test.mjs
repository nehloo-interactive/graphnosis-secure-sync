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
