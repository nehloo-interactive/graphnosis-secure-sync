import { DEFAULT_BUDGET, TIER_CAPS, budgetFor, estimateTokens, redactNode, shareableGraphs, tierOf, } from '../policy/index.js';
export async function federatedQuery(runner, graphIds, query, cfg, budget = DEFAULT_BUDGET) {
    const shareable = shareableGraphs(cfg, graphIds);
    const perGraphK = Math.max(5, Math.ceil(budget.maxNodes / Math.max(1, shareable.length)) * 2);
    // Run all per-graph queries in parallel.
    const results = await Promise.all(shareable.map(async (g) => [g, await runner.runQuery(g, query, perGraphK)]));
    // Layer 1: per-graph tier cap. Compute it once per graph; track running usage.
    const graphCaps = new Map();
    for (const g of shareable) {
        const cap = budgetFor(cfg, g, budget);
        graphCaps.set(g, { ...cap, usedTokens: 0, usedNodes: 0 });
    }
    // Apply per-graph policy filters (redaction).
    const filtered = [];
    for (const [g, candidates] of results) {
        const policy = cfg.graphs.find(p => p.graphId === g);
        for (const c of candidates) {
            const probe = { content: c.text };
            if (c.type !== undefined)
                probe.type = c.type;
            if (c.tags !== undefined)
                probe.tags = c.tags;
            if (redactNode(probe, policy))
                continue;
            filtered.push(c);
        }
    }
    // Interleave across graphs by score, respecting both tier caps and the global budget.
    // Deterministic tie-breaker: when two candidates score identically (very common
    // under entity anchoring's ANCHOR_SCORE constant, where every literal-entity
    // match collapses to the same score), fall back to graphId then nodeId
    // lexicographic order. Without this, ties are broken by the per-graph
    // Promise.all completion order — which depends on I/O timing and produces
    // non-deterministic "top result" placements across otherwise-identical
    // recall calls.
    filtered.sort((a, b) => (b.score - a.score) ||
        a.graphId.localeCompare(b.graphId) ||
        a.nodeId.localeCompare(b.nodeId));
    const byGraph = new Map();
    let totalTokens = 0;
    let totalCount = 0;
    const minPerGraph = budget.perGraphMinTokens ?? 0;
    const reserved = new Map();
    for (const g of shareable)
        reserved.set(g, minPerGraph);
    for (const cand of filtered) {
        if (totalCount >= budget.maxNodes)
            break;
        const t = estimateTokens(cand.text);
        const cap = graphCaps.get(cand.graphId);
        if (!cap)
            continue;
        // Per-graph tier cap is hard.
        if (cap.usedNodes >= cap.maxNodes)
            continue;
        if (cap.usedTokens + t > cap.maxTokens)
            continue;
        // Global budget allows a reserved minimum per graph; otherwise yields to the budget.
        const reservedHere = reserved.get(cand.graphId) ?? 0;
        if (totalTokens + t > budget.maxTokens && reservedHere <= 0)
            continue;
        const bucket = byGraph.get(cand.graphId) ?? [];
        bucket.push(cand);
        byGraph.set(cand.graphId, bucket);
        cap.usedTokens += t;
        cap.usedNodes += 1;
        totalTokens += t;
        totalCount += 1;
        if (reservedHere > 0)
            reserved.set(cand.graphId, Math.max(0, reservedHere - t));
    }
    const audit = [];
    for (const g of shareable) {
        const cap = graphCaps.get(g);
        audit.push({
            graphId: g,
            tier: tierOf(cfg, g),
            nodesIncluded: cap.usedNodes,
            tokensIncluded: cap.usedTokens,
        });
    }
    return { byGraph, prompt: renderPrompt(byGraph), tokensUsed: totalTokens, nodesIncluded: totalCount, audit };
}
function renderPrompt(byGraph) {
    const sections = [];
    sections.push('# Graphnosis context');
    sections.push('The following memories from the user\'s personal graphs may be relevant.');
    for (const [g, items] of byGraph) {
        sections.push(`\n## Graph: ${g}`);
        for (const item of items) {
            sections.push(`- ${item.text}`);
        }
    }
    return sections.join('\n');
}
export { TIER_CAPS };
//# sourceMappingURL=index.js.map