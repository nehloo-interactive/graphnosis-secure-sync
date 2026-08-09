export const DEFAULT_BUDGET = {
    maxTokens: 2_000,
    maxNodes: 20,
    perGraphMinTokens: 200,
};
/** Map legacy `personal` → `deidentified`. Unknown / missing → deidentified. */
export function normalizeSensitivityTier(raw) {
    if (raw === 'public' || raw === 'deidentified' || raw === 'sensitive')
        return raw;
    if (raw === 'personal')
        return 'deidentified';
    return 'deidentified';
}
// Per-tier hard caps applied *after* the user-/AI-requested budget.
// A request asking for 5000 tokens against a sensitive graph still gets ≤ 500.
export const TIER_CAPS = {
    public: { maxTokens: 8_000, maxNodes: 50 },
    deidentified: { maxTokens: 2_000, maxNodes: 20 },
    sensitive: { maxTokens: 500, maxNodes: 5 },
};
export function tierOf(cfg, graphId) {
    return normalizeSensitivityTier(cfg.graphs.find(g => g.graphId === graphId)?.tier);
}
/**
 * Why `shouldShare` refuses, or `undefined` when it does not.
 *
 * Exists so an audit can state WHICH guarantee fired for a withheld engram
 * without re-deriving the rule and slowly diverging from the real decision:
 * `shouldShare` is defined in terms of this function, so there is exactly one
 * implementation of the rule and the audit cannot disagree with the filter.
 */
export function withholdReason(cfg, graphId) {
    const g = cfg.graphs.find(x => x.graphId === graphId);
    // Hard backstop: a `sensitive`-tier engram is NEVER federated to an AI,
    // regardless of its `shareWithAi` flag. The two axes are settable
    // independently (and an env-supplied GRAPHNOSIS_POLICY bypasses the host's
    // safety derivation that normally forces shareWithAi=false for sensitive), so
    // this re-checks the tier here as an independent guard against that decoupling.
    if (normalizeSensitivityTier(g?.tier) === 'sensitive')
        return 'sensitive-tier';
    if (g && !g.shareWithAi)
        return 'sharing-disabled';
    // No policy entry ⇒ shareable, unchanged.
    return undefined;
}
export function shouldShare(cfg, graphId) {
    return withholdReason(cfg, graphId) === undefined;
}
export function shareableGraphs(cfg, graphIds, allowGraphIds) {
    // `allowGraphIds` is an explicit allow-list for engrams the CALLER has already
    // authorised out-of-band (e.g. the app's per-engram consent gate approved an
    // explicitly-named sensitive engram). Those bypass the share filter — but only
    // the share filter; the per-tier budget cap in `budgetFor` still clamps how
    // much they can contribute (sensitive = 500 tok / 5 nodes). Without an
    // allow-list this is unchanged: sensitive stays non-shareable (proactive
    // recall never leaks it).
    return graphIds.filter(g => shouldShare(cfg, g) || allowGraphIds?.includes(g));
}
/** Per-graph budget = min(requested, tier cap). */
export function budgetFor(cfg, graphId, requested) {
    const cap = TIER_CAPS[tierOf(cfg, graphId)];
    return {
        maxTokens: Math.min(requested.maxTokens, cap.maxTokens),
        maxNodes: Math.min(requested.maxNodes, cap.maxNodes),
    };
}
// Very rough token estimate. The sidecar can swap in a real tokenizer if needed.
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
export function redactNode(node, policy) {
    if (!policy)
        return false;
    if (node.type && policy.excludeNodeTypes?.includes(node.type))
        return true;
    if (node.tags && policy.excludeTags && node.tags.some(t => policy.excludeTags.includes(t)))
        return true;
    return false;
}
//# sourceMappingURL=index.js.map