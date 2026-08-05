import { DEFAULT_BUDGET, TIER_CAPS, budgetFor, estimateTokens, redactNode, shareableGraphs, tierOf, withholdReason, } from '../policy/index.js';
/** Engrams that failed to answer. Empty ⇒ the result covers every shareable engram. */
export function federationFailures(sub) {
    return sub.complete ? [] : sub.failures;
}
export async function federatedQuery(runner, graphIds, query, cfg, budget = DEFAULT_BUDGET, 
/**
 * Engrams the caller has explicitly authorised (e.g. an app-side per-engram
 * consent gate approved an explicitly-named sensitive engram). These bypass
 * the shareability filter so a consented sensitive recall actually returns
 * data — still clamped by the per-tier budget cap. Proactive recall passes
 * nothing here, so sensitive stays excluded by default.
 */
allowGraphIds, opts) {
    const shareable = shareableGraphs(cfg, graphIds, allowGraphIds);
    const perGraphK = Math.max(5, Math.ceil(budget.maxNodes / Math.max(1, shareable.length)) * 2);
    const timeoutMs = opts?.timeoutMs ?? resolveTimeoutMs(shareable.length);
    // Run all per-graph queries in parallel, tolerating per-graph failure.
    // `Promise.all` here meant one slow or broken engram rejected the whole
    // federated recall and the user got nothing — every healthy engram's answer
    // thrown away because of one sibling. `allSettled` degrades per graph instead
    // (and stays `allSettled` rather than `Promise.all` over a try//catch mapper,
    // so the batch cannot be made abortable again by a later edit to the mapper).
    // The failures are NOT swallowed: each becomes a `status: 'failed'` audit row
    // AND a `GraphFailure` on the `complete: false` branch of the return type.
    const settled = await Promise.allSettled(shareable.map(async (g) => [
        g,
        await withTimeout(runner.runQuery(g, query, perGraphK), timeoutMs),
    ]));
    const results = [];
    const failures = new Map();
    for (let i = 0; i < settled.length; i++) {
        const g = shareable[i];
        const outcome = settled[i];
        if (g === undefined || outcome === undefined)
            continue;
        if (outcome.status === 'fulfilled') {
            results.push(outcome.value);
        }
        else {
            failures.set(g, {
                reason: outcome.reason instanceof GraphQueryTimeout ? 'timeout' : 'error',
                error: describeError(outcome.reason),
            });
        }
    }
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
    // lexicographic order. Without this, ties are broken by the order the
    // per-graph queries settle in — which depends on I/O timing and produces
    // non-deterministic "top result" placements across otherwise-identical
    // recall calls. (Still true under `allSettled`: it preserves input order in
    // its result array, but the underlying queries finish whenever they finish.)
    filtered.sort((a, b) => (b.score - a.score) ||
        a.graphId.localeCompare(b.graphId) ||
        a.nodeId.localeCompare(b.nodeId));
    // Collapse duplicated content BEFORE budgeting, so the budget buys distinct
    // evidence. Runs on the sorted array, so the surviving copy is picked
    // deterministically (see `dedupeByContent`).
    const { kept: deduped, droppedByGraph } = dedupeByContent(filtered, cfg);
    const byGraph = new Map();
    let totalTokens = 0;
    let totalCount = 0;
    const minPerGraph = budget.perGraphMinTokens ?? 0;
    const reserved = new Map();
    for (const g of shareable)
        reserved.set(g, minPerGraph);
    for (const cand of deduped) {
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
    // One row per REQUESTED engram — the queried ones in `audit`, the ones policy
    // kept out in `withheld`. An engram that was withheld is a result, not an
    // absence, but it is deliberately NOT in the array callers count: see
    // `WithheldGraphAudit`.
    const inScope = new Set(shareable);
    const audit = [];
    const withheld = [];
    const failureList = [];
    for (const g of graphIds) {
        const tier = tierOf(cfg, g);
        if (!inScope.has(g)) {
            // `withholdReason` is the same function `shouldShare` is defined in terms
            // of, so this row cannot claim a different reason than the filter used.
            // It is only ever undefined if the graph was dropped for some reason
            // other than policy, which cannot happen today; fall back to the stricter
            // of the two rather than inventing a third status.
            withheld.push({ graphId: g, tier, status: 'withheld', reason: withholdReason(cfg, g) ?? 'sharing-disabled' });
            continue;
        }
        const cap = graphCaps.get(g);
        const failure = failures.get(g);
        if (failure !== undefined) {
            // No counts on this row, by construction — see `FailedGraphAudit`.
            audit.push({ graphId: g, tier, status: 'failed', error: failure.error });
            failureList.push({ graphId: g, tier, reason: failure.reason, error: failure.error });
            continue;
        }
        audit.push({
            graphId: g,
            tier,
            status: 'ok',
            nodesIncluded: cap.usedNodes,
            tokensIncluded: cap.usedTokens,
            duplicatesDropped: droppedByGraph.get(g) ?? 0,
        });
    }
    const base = { byGraph, tokensUsed: totalTokens, nodesIncluded: totalCount, audit, withheld };
    if (failureList.length === 0) {
        return { ...base, complete: true, prompt: renderPrompt(byGraph, audit) };
    }
    return { ...base, complete: false, failures: failureList, partialPrompt: renderPrompt(byGraph, audit) };
}
function describeError(reason) {
    if (reason instanceof Error)
        return reason.message || reason.name;
    return String(reason);
}
// --- Per-graph timeout -------------------------------------------------------
/**
 * Base allowance for reading one engram: a cold ONNX/embedding init, decrypt,
 * and the query itself.
 */
const TIMEOUT_BASE_MS = 15_000;
/**
 * Added per ADDITIONAL engram in scope. See `resolveTimeoutMs` for why the
 * default has to grow with the size of the request.
 */
const TIMEOUT_PER_QUEUED_GRAPH_MS = 5_000;
/**
 * Default per-engram allowance.
 *
 * THE CLOCK NECESSARILY STARTS AT DISPATCH, NOT WHEN THE WORK STARTS. The
 * `FederatedQueryRunner` contract is a bare `runQuery(...) => Promise`: the host
 * is free to queue internally (the desktop sidecar serialises every per-graph
 * call through one chain, because ONNX is not safe under concurrent
 * invocation), and federation has no way to observe when a call leaves that
 * queue. Timing an engram from dispatch therefore charges it for the queue
 * ahead of it — so a flat timeout would start killing HEALTHY engrams exactly
 * when several recalls overlap, converting a robustness fix into a new failure
 * mode. Observing the true start would need a contract change (a `started`
 * callback, or the AbortSignal noted in `withTimeout`); until then the default
 * absorbs the queue by growing with the number of engrams in scope: a 12-engram
 * recall allows 70s, of which any single engram would normally use well under a
 * second. This is a backstop against "never", not a latency target.
 */
export function resolveTimeoutMs(graphCount) {
    return TIMEOUT_BASE_MS + TIMEOUT_PER_QUEUED_GRAPH_MS * Math.max(0, graphCount - 1);
}
class GraphQueryTimeout extends Error {
    constructor(ms) {
        super(`timed out after ${ms}ms`);
        this.name = 'GraphQueryTimeout';
    }
}
/**
 * Reject with `GraphQueryTimeout` if `work` has not settled within `ms`.
 *
 * `allSettled` fixes the engram that FAILS; it does nothing for the engram that
 * HANGS — a stalled network mount, a lock held forever. That promise never
 * settles, so without this the whole recall waits indefinitely: no error, no
 * result, no end, which is worse for a user than a failure.
 *
 * KNOWN LIMITATION — THIS IS TIMEOUT-AND-IGNORE, NOT CANCELLATION. The
 * abandoned `work` promise keeps running, holding whatever the host allocated
 * for it (a file handle, a read transaction, an ONNX slot) until it settles on
 * its own, if it ever does. Stopping the read for real needs an AbortSignal
 * threaded through `FederatedQueryRunner.runQuery`, i.e. a change to the runner
 * contract and to every host that implements it — a deliberate decision, left
 * to a later change rather than smuggled in here. A late rejection from the
 * abandoned promise is absorbed by the race and cannot surface as an unhandled
 * rejection.
 */
function withTimeout(work, ms) {
    let timer;
    const alarm = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new GraphQueryTimeout(ms)), ms);
    });
    return Promise.race([work, alarm]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
// --- Content deduplication ---------------------------------------------------
/** Whitespace-only differences are not different memories; anything else is. */
function normalizeContent(text) {
    return text.trim().replace(/\s+/g, ' ');
}
/**
 * 32-bit DJB2 over the normalized content, hex-encoded.
 *
 * This is a BUCKET KEY, never an identity. 32 bits collide at corpus scale
 * (birthday bound: ~25% odds by 50k distinct memories), and dropping a node on
 * a bare hash match is how the SDK silently deleted a DIFFERENT memory that
 * happened to collide. Every caller here re-checks the normalized content
 * inside the bucket before dropping anything — a hash match with different
 * content is a collision, and both nodes are kept.
 *
 * Exported so tests can pin the collision behaviour against a real collision.
 */
export function contentFingerprint(text) {
    const norm = normalizeContent(text);
    let h = 5381;
    for (let i = 0; i < norm.length; i++)
        h = (((h << 5) + h) + norm.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
}
const TIER_RANK = { public: 0, personal: 1, sensitive: 2 };
/**
 * Collapse candidates whose content is identical, keeping exactly one copy.
 *
 * Must run BEFORE budget allocation: the same note synced into two engrams
 * otherwise pays twice out of one token budget and displaces distinct evidence.
 *
 * WHICH COPY SURVIVES IS DETERMINISTIC — the input is already sorted by
 * (score desc, graphId, nodeId), and the only re-ordering rule applied on top
 * is tier rank, which is a pure function of the policy config:
 *   1. Lowest sensitivity tier wins. Identical content available from a public
 *      engram must not be charged to the `sensitive` engram's 500-token / 5-node
 *      cap — that would spend the scarcest budget in the system on evidence that
 *      was free elsewhere, and re-attribute the memory to the sensitive engram
 *      in the rendered prompt.
 *   2. Otherwise the earlier entry in the sorted order wins, i.e. higher score,
 *      then graphId, then nodeId.
 * Nothing here depends on which engram's promise settled first, so the same
 * inputs always yield the same survivor.
 */
function dedupeByContent(candidates, cfg) {
    const buckets = new Map();
    const droppedByGraph = new Map();
    const drop = (g) => droppedByGraph.set(g, (droppedByGraph.get(g) ?? 0) + 1);
    for (const cand of candidates) {
        const norm = normalizeContent(cand.text);
        const fp = contentFingerprint(cand.text);
        const bucket = buckets.get(fp);
        if (bucket === undefined) {
            buckets.set(fp, [{ norm, best: cand }]);
            continue;
        }
        // Verify the CONTENT, not just the hash. A hash hit with different content
        // is a collision between two genuinely different memories: keep both.
        const group = bucket.find(g => g.norm === norm);
        if (group === undefined) {
            bucket.push({ norm, best: cand });
            continue;
        }
        if (TIER_RANK[tierOf(cfg, cand.graphId)] < TIER_RANK[tierOf(cfg, group.best.graphId)]) {
            drop(group.best.graphId);
            group.best = cand;
        }
        else {
            drop(cand.graphId);
        }
    }
    const survivors = new Set();
    for (const bucket of buckets.values())
        for (const group of bucket)
            survivors.add(group.best);
    const kept = [];
    const emitted = new Set();
    for (const cand of candidates) {
        if (!survivors.has(cand) || emitted.has(cand))
            continue;
        emitted.add(cand);
        kept.push(cand);
    }
    return { kept, droppedByGraph };
}
function renderPrompt(byGraph, audit) {
    const sections = [];
    sections.push('# Graphnosis context');
    sections.push('The following memories from the user\'s personal graphs may be relevant.');
    // Tell the model the evidence is incomplete when it is. Without this an
    // unreadable engram reads downstream as an engram with nothing to say, and
    // the model asserts an absence it never verified.
    //
    // A WITHHELD engram cannot be named here even by accident: withheld rows are
    // not in `audit` at all. That is structural rather than a filter to get right
    // — the banner is model-facing text, and naming "clinic-records was withheld"
    // would disclose to the AI both that a sensitive engram exists and that it
    // was relevant enough to be in scope. Withholding that leaks the withholding
    // is not withholding. Withheld rows go to the caller on `sub.withheld`, which
    // is user-facing, not to the model.
    const failed = audit.filter(a => a.status === 'failed');
    if (failed.length > 0) {
        sections.push(`\n> INCOMPLETE CONTEXT: ${failed.length} engram(s) could not be queried ` +
            `(${failed.map(f => f.graphId).join(', ')}). Absence of a memory below is NOT evidence it does not exist.`);
    }
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