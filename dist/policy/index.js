export const DEFAULT_BUDGET = {
    maxTokens: 2_000,
    maxNodes: 20,
    perGraphMinTokens: 200,
};
// Per-tier hard caps applied *after* the user-/AI-requested budget.
// A request asking for 5000 tokens against a sensitive graph still gets ≤ 500.
export const TIER_CAPS = {
    public: { maxTokens: 8_000, maxNodes: 50 },
    personal: { maxTokens: 2_000, maxNodes: 20 },
    sensitive: { maxTokens: 500, maxNodes: 5 },
};
export function tierOf(cfg, graphId) {
    return cfg.graphs.find(g => g.graphId === graphId)?.tier ?? 'personal';
}
export function shouldShare(cfg, graphId) {
    const g = cfg.graphs.find(x => x.graphId === graphId);
    // Hard backstop: a `sensitive`-tier engram is NEVER federated to an AI,
    // regardless of its `shareWithAi` flag. The two axes are settable
    // independently (and an env-supplied GRAPHNOSIS_POLICY bypasses the host's
    // safety derivation that normally forces shareWithAi=false for sensitive), so
    // this re-checks the tier here as an independent guard against that decoupling.
    if (g?.tier === 'sensitive')
        return false;
    return g ? g.shareWithAi : true;
}
export function shareableGraphs(cfg, graphIds) {
    return graphIds.filter(g => shouldShare(cfg, g));
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