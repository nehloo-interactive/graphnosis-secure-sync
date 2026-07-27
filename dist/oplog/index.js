import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt, sign, verify } from '../crypto/index.js';
// Append-only encrypted op-log. One file per device, materialized into .aikg locally.
// Sync layer (iCloud/Drive) syncs the directory of op-log files, not the .aikg.
//
// ── Format v2 (signed + sequenced) ──────────────────────────────────────────
// The op-log chunks are AEAD-encrypted with the shared per-cortex data key, so a
// party WITHOUT that key can't read or forge content — but they can still drop,
// truncate, reorder, or replay whole chunks on the synced directory, and a party
// WITH the key (a stolen synced copy) could forge events for any device. v2
// closes both:
//   • Each event carries a strictly-monotonic per-device `seq`; the reader
//     detects gaps (drops), rewinds (replays), and reorders.
//   • Each chunk is Ed25519-signed by the originating device; the reader
//     verifies against a TOFU-pinned per-device public key, so only the holder
//     of a device's private key can author that device's events.
//   • The reader clamps future timestamps so a poisoned `ts` can't win LWW.
// Integrity problems are surfaced to the caller (loud), not silently skipped.
//
// A v2 file begins with the magic below; legacy v1 files (length-prefixed
// chunks, no magic) are still read best-effort and grandfathered.
// "GNOL" + version 2. Distinguishes a v2 file from a legacy v1 file (which
// begins with a u32 length prefix, never these bytes).
const V2_FILE_MAGIC = new Uint8Array([0x47, 0x4e, 0x4f, 0x4c, 0x02]);
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export class OpLogWriter {
    opts;
    sessionId = randomUUID();
    buffer = [];
    flushing = false;
    seq;
    constructor(opts) {
        this.opts = opts;
        this.seq = opts.initialSeq ?? 0;
    }
    filePath() {
        return path.join(this.opts.dir, `${this.opts.deviceId}.oplog`);
    }
    emit(partial) {
        const ev = {
            id: randomUUID(),
            ts: Date.now(),
            deviceId: this.opts.deviceId,
            sessionId: this.sessionId,
            seq: this.seq++,
            ...partial,
        };
        this.buffer.push(ev);
        void this.flush();
        return ev;
    }
    async flush() {
        if (this.flushing || this.buffer.length === 0)
            return;
        this.flushing = true;
        try {
            const batch = this.buffer.splice(0, this.buffer.length);
            const line = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
            const ct = await encrypt(new TextEncoder().encode(line), this.opts.key, this.opts.salt);
            await fs.mkdir(this.opts.dir, { recursive: true, mode: 0o700 });
            let record;
            let needMagic = false;
            if (this.opts.signSecretKey) {
                const startSeq = batch[0]?.seq ?? 0;
                record = await buildV2Chunk(this.opts.deviceId, startSeq, batch.length, ct, this.opts.signSecretKey);
                // The v2 file magic is written once, the first time the file is created.
                needMagic = !(await fileExists(this.filePath()));
            }
            else {
                record = prefixLen(ct); // legacy v1
            }
            const payload = needMagic ? concat([V2_FILE_MAGIC, record]) : record;
            // Restrictive perms: the op-log dir/files hold the user's (encrypted)
            // memory ops. 0o700 dir / 0o600 file (applies on creation).
            await fs.appendFile(this.filePath(), Buffer.from(payload), { mode: 0o600 });
            await this.opts.persistSeq?.(this.seq);
        }
        finally {
            this.flushing = false;
            if (this.buffer.length > 0)
                void this.flush();
        }
    }
}
/** The v2 file magic (written once at the start of a v2 op-log file). Exported
 *  so the app's compaction path can produce valid v2 files. */
export const OPLOG_V2_MAGIC = V2_FILE_MAGIC;
/** Encode a batch of events as one signed v2 chunk (no file magic). Used by the
 *  app's op-log compaction to rewrite its own file in v2 format. The chunk's
 *  startSeq is the first event's seq; pruned events simply leave seq gaps, which
 *  the reader reports as benign. */
export async function encodeSignedChunk(deviceId, batch, key, salt, signSecretKey) {
    const line = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
    const ct = await encrypt(new TextEncoder().encode(line), key, salt);
    const startSeq = batch[0]?.seq ?? 0;
    return buildV2Chunk(deviceId, startSeq, batch.length, ct, signSecretKey);
}
/** Build one signed v2 chunk:
 *  [u16 idLen][idBytes][u32 seqLo][u32 seqHi][u32 count][32B sha256(ct)][64B sig][u32 ctLen][ct]
 *  The signature covers (magic || idLen||id || seq || count || sha256(ct)). */
async function buildV2Chunk(deviceId, startSeq, count, ct, signSecretKey) {
    const idBytes = new TextEncoder().encode(deviceId);
    const ctHash = new Uint8Array(createHash('sha256').update(ct).digest());
    const header = concat([
        u16(idBytes.length), idBytes,
        u32(startSeq >>> 0), u32(Math.floor(startSeq / 0x1_0000_0000)),
        u32(count >>> 0),
        ctHash,
    ]);
    // Sign the version-tagged header so a chunk can't be replayed under a different
    // format version or moved between devices/positions.
    const signed = concat([V2_FILE_MAGIC, header]);
    const sig = await sign(signed, signSecretKey);
    return concat([header, sig, u32(ct.length >>> 0), ct]);
}
/**
 * Per-process memo of op-log filenames we've already warned about, to avoid
 * spamming the dev terminal across repeated reads in one session.
 */
const warnedOplogFiles = new Set();
function isAfterCheckpoint(ev, sinceTs, sinceSeq) {
    if (ev.ts > sinceTs)
        return true;
    if (ev.ts < sinceTs)
        return false;
    if (sinceSeq === undefined)
        return false;
    return typeof ev.seq === 'number' && ev.seq > sinceSeq;
}
function sortEvents(events) {
    events.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    return events;
}
async function collectOplogFromDir(dir, passphraseOrKey, opts, filter) {
    const out = [];
    const now = opts.now ?? Date.now();
    const maxSkew = opts.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
    const issue = (i) => opts.onIntegrityIssue?.(i);
    let entries = [];
    try {
        entries = await fs.readdir(dir);
    }
    catch {
        return out;
    }
    for (const name of entries) {
        if (!name.endsWith('.oplog'))
            continue;
        const buf = await fs.readFile(path.join(dir, name));
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const fileEvents = startsWith(u8, V2_FILE_MAGIC)
            ? await readV2File(u8, name, passphraseOrKey, opts, issue)
            : await readV1File(u8, name, passphraseOrKey, issue);
        // Per-device seq continuity (drop / replay / reorder detection).
        checkSequenceContinuity(fileEvents, name, issue);
        for (const ev of fileEvents) {
            // Clamp poisoned / wildly-skewed timestamps: drop events claiming to be
            // from the future so a single bad ts can't win last-writer-wins forever.
            if (typeof ev.ts === 'number' && ev.ts > now + maxSkew) {
                issue({ kind: 'future-timestamp', deviceId: ev.deviceId, file: name,
                    detail: `event ts ${ev.ts} exceeds now+${maxSkew}ms; dropped` });
                continue;
            }
            if (!filter || filter(ev))
                out.push(ev);
        }
    }
    return sortEvents(out);
}
export async function readAllEvents(dir, passphraseOrKey, opts = {}) {
    return collectOplogFromDir(dir, passphraseOrKey, opts);
}
/** Read op-log events strictly after a reconcile checkpoint (tail replay). */
export async function readEventsSince(dir, passphraseOrKey, since) {
    const { sinceTs, sinceSeq, ...opts } = since;
    return collectOplogFromDir(dir, passphraseOrKey, opts, (ev) => isAfterCheckpoint(ev, sinceTs, sinceSeq));
}
/** v2: magic, then repeated signed chunks. Verifies signature + content hash. */
async function readV2File(u8, name, passphraseOrKey, opts, issue) {
    const events = [];
    let cursor = V2_FILE_MAGIC.length;
    while (cursor < u8.length) {
        const parsed = parseV2Chunk(u8, cursor);
        if (!parsed) {
            issue({ kind: 'malformed', file: name, detail: `truncated/garbled v2 chunk at offset ${cursor}` });
            break;
        }
        const { deviceId, startSeq, count, ctHash, sig, ct, next } = parsed;
        cursor = next;
        // Verify the signature against the device's pinned public key.
        if (opts.getDevicePubKey) {
            const pub = opts.getDevicePubKey(deviceId);
            if (!pub) {
                issue({ kind: 'unknown-device', deviceId, file: name,
                    detail: `no pinned public key for device; chunk not trusted` });
                continue;
            }
            const signed = concat([
                V2_FILE_MAGIC,
                u16(new TextEncoder().encode(deviceId).length), new TextEncoder().encode(deviceId),
                u32(startSeq >>> 0), u32(Math.floor(startSeq / 0x1_0000_0000)),
                u32(count >>> 0),
                ctHash,
            ]);
            const ok = await verify(sig, signed, pub);
            if (!ok) {
                issue({ kind: 'signature-invalid', deviceId, file: name,
                    detail: `Ed25519 signature failed for seq ${startSeq}..${startSeq + count - 1}` });
                continue;
            }
        }
        // Verify the content hash matches the signed header (defends the ct bytes).
        const actualHash = new Uint8Array(createHash('sha256').update(ct).digest());
        if (!bytesEqual(actualHash, ctHash)) {
            issue({ kind: 'signature-invalid', deviceId, file: name,
                detail: `content hash mismatch for seq ${startSeq}..${startSeq + count - 1}` });
            continue;
        }
        let pt;
        try {
            pt = await decrypt(ct, passphraseOrKey);
        }
        catch (e) {
            issue({ kind: 'malformed', deviceId, file: name,
                detail: `decrypt failed: ${e instanceof Error ? e.message : String(e)}` });
            continue;
        }
        // ── Bind the decrypted events to the SIGNED header ──────────────────────
        // The signature covers only (deviceId, startSeq, count, sha256(ct)). Without
        // the checks below, a device that holds the shared per-cortex data key can sign
        // a well-formed header of its own while encrypting events that claim ANOTHER
        // device's id and rank; the reducer would then attribute and order them as that
        // device. That is the forgery v2 exists to prevent, so a chunk that fails any
        // check is rejected whole rather than partially trusted.
        //
        // Note on seq: compaction prunes events and legitimately leaves gaps inside a
        // chunk (see encodeSignedChunk), so contiguity CANNOT be required. What is
        // bindable is: the count is signed, startSeq is defined as the first event's
        // seq, and ranks must not move backwards.
        const candidates = [];
        let lineMalformed = false;
        for (const ln of new TextDecoder().decode(pt).split('\n')) {
            if (!ln)
                continue;
            try {
                candidates.push(JSON.parse(ln));
            }
            catch {
                issue({ kind: 'malformed', deviceId, file: name, detail: 'decrypted line not JSON' });
                lineMalformed = true;
            }
        }
        if (lineMalformed)
            continue;
        const reject = (detail) => {
            issue({ kind: 'signature-invalid', deviceId, file: name, detail });
        };
        if (candidates.length !== count) {
            reject(`chunk header signs ${count} event(s) but the payload carries ` +
                `${candidates.length}; chunk rejected`);
            continue;
        }
        const foreign = candidates.find(ev => ev.deviceId !== deviceId);
        if (foreign) {
            reject(`chunk signed by "${deviceId}" carries an event claiming ` +
                `deviceId="${foreign.deviceId}"; chunk rejected (cross-device forgery)`);
            continue;
        }
        const unranked = candidates.find(ev => typeof ev.seq !== 'number');
        if (unranked) {
            reject(`v2 chunk carries an event with no seq; chunk rejected`);
            continue;
        }
        if (candidates[0].seq !== startSeq) {
            reject(`chunk header signs startSeq ${startSeq} but the first event has seq ` +
                `${candidates[0].seq}; chunk rejected`);
            continue;
        }
        // Gaps are permitted (pruning); backwards or repeated ranks are not.
        let prevSeq = -1;
        const misordered = candidates.some(ev => {
            const s = ev.seq;
            if (s <= prevSeq)
                return true;
            prevSeq = s;
            return false;
        });
        if (misordered) {
            reject(`chunk events are not strictly ascending in seq from ${startSeq}; ` +
                `chunk rejected`);
            continue;
        }
        events.push(...candidates);
    }
    return events;
}
/** Legacy v1: length-prefixed AEAD chunks, unsigned. Read best-effort. */
async function readV1File(u8, name, passphraseOrKey, issue) {
    const events = [];
    let cursor = 0;
    let skipped = 0;
    let firstReason = '';
    while (cursor + 4 <= u8.length) {
        const len = new DataView(u8.buffer, u8.byteOffset + cursor, 4).getUint32(0, true);
        cursor += 4;
        if (len === 0 || cursor + len > u8.length) {
            skipped++;
            firstReason ||= 'malformed length prefix';
            break;
        }
        const chunk = u8.subarray(cursor, cursor + len);
        cursor += len;
        let pt;
        try {
            pt = await decrypt(chunk, passphraseOrKey);
        }
        catch (e) {
            skipped++;
            firstReason ||= (e instanceof Error ? e.message : String(e));
            continue;
        }
        for (const ln of new TextDecoder().decode(pt).split('\n')) {
            if (!ln)
                continue;
            try {
                events.push(JSON.parse(ln));
            }
            catch {
                skipped++;
                firstReason ||= 'decrypted chunk was not valid JSON';
            }
        }
    }
    if (skipped > 0 && !warnedOplogFiles.has(name)) {
        warnedOplogFiles.add(name);
        console.error(`[oplog] skipped ${skipped} chunk(s) in legacy file ${name} — first reason: ${firstReason}. ` +
            `Likely a leftover from a previous passphrase or a corrupted segment.`);
        issue({ kind: 'malformed', file: name, detail: `${skipped} legacy chunk(s) skipped: ${firstReason}` });
    }
    return events;
}
function parseV2Chunk(u8, at) {
    let c = at;
    if (c + 2 > u8.length)
        return null;
    const idLen = readU16(u8, c);
    c += 2;
    if (c + idLen > u8.length)
        return null;
    const deviceId = new TextDecoder().decode(u8.subarray(c, c + idLen));
    c += idLen;
    if (c + 4 + 4 + 4 > u8.length)
        return null;
    const seqLo = readU32(u8, c);
    c += 4;
    const seqHi = readU32(u8, c);
    c += 4;
    const startSeq = seqHi * 0x1_0000_0000 + seqLo;
    const count = readU32(u8, c);
    c += 4;
    if (c + 32 > u8.length)
        return null;
    const ctHash = u8.subarray(c, c + 32);
    c += 32;
    if (c + 64 > u8.length)
        return null;
    const sig = u8.subarray(c, c + 64);
    c += 64;
    if (c + 4 > u8.length)
        return null;
    const ctLen = readU32(u8, c);
    c += 4;
    if (ctLen === 0 || c + ctLen > u8.length)
        return null;
    const ct = u8.subarray(c, c + ctLen);
    c += ctLen;
    return { deviceId, startSeq, count, ctHash, sig, ct, next: c };
}
/** Detect dropped / replayed / reordered events via per-device seq continuity. */
function checkSequenceContinuity(events, file, issue) {
    const byDevice = new Map();
    for (const ev of events) {
        if (typeof ev.seq !== 'number')
            continue; // legacy v1 — no seq to check
        let arr = byDevice.get(ev.deviceId);
        if (!arr) {
            arr = [];
            byDevice.set(ev.deviceId, arr);
        }
        arr.push(ev.seq);
    }
    for (const [deviceId, seqs] of byDevice) {
        seqs.sort((a, b) => a - b);
        for (let i = 1; i < seqs.length; i++) {
            const cur = seqs[i];
            const prev = seqs[i - 1];
            if (cur === prev) {
                issue({ kind: 'seq-rewind', deviceId, file,
                    detail: `duplicate seq ${cur} — possible replay` });
            }
            else if (cur > prev + 1) {
                issue({ kind: 'seq-gap', deviceId, file,
                    detail: `gap between seq ${prev} and ${cur} — possible dropped events` });
            }
        }
    }
}
// Deterministic merge: per (graphId, target.id) last-writer-wins under the
// strict total order (ts, deviceId, seq). The reader has already dropped
// future-ts events, so a poisoned timestamp can no longer win here. The seq
// tie-break makes the merge order-independent even when one device emits two
// events for the same target in the same millisecond; deletes are retained as
// ranked tombstones during the merge and swept afterward, so order-independence
// extends to delete/set interleavings too (Theorem 2 over the full event set).
export function reduce(events) {
    const graphs = new Map();
    for (const ev of events) {
        let g = graphs.get(ev.graphId);
        if (!g) {
            g = { nodes: new Map(), edges: new Map(), sources: new Map() };
            graphs.set(ev.graphId, g);
        }
        applyEvent(g, ev);
    }
    // Sweep tombstones: deletes were kept as ranked tombstones so they correctly
    // suppress lower-ranked sets regardless of merge order; the externally visible
    // state omits them. The sweep is order-independent (it removes every tombstone
    // unconditionally), so materialize(π(E)) = materialize(E) for any permutation π.
    for (const g of graphs.values()) {
        for (const bucket of [g.nodes, g.edges, g.sources]) {
            for (const [id, entry] of bucket) {
                if (entry.deleted)
                    bucket.delete(id);
            }
        }
    }
    return graphs;
}
function applyEvent(g, ev) {
    const bucket = ev.target.kind === 'node' ? g.nodes :
        ev.target.kind === 'edge' ? g.edges :
            g.sources;
    const existing = bucket.get(ev.target.id);
    // Strict total order (ts, deviceId, seq). seq is the strictly-monotonic
    // per-device sequence number, so two events from the same device at the same
    // ts can never tie — making the merge order-independent (Theorem 2) even in
    // the degenerate same-device, same-millisecond case. Legacy v1 events carry
    // no seq and fall back to (ts, deviceId) ordering.
    const wins = !existing || ev.ts > existing.ts ||
        (ev.ts === existing.ts && ev.deviceId > existing.deviceId) ||
        (ev.ts === existing.ts && ev.deviceId === existing.deviceId && (ev.seq ?? 0) > (existing.seq ?? 0));
    if (!wins)
        return;
    if (ev.op === 'deleteNode' || ev.op === 'deleteEdge' || ev.op === 'forgetSource') {
        // Tombstone, not removal. A delete that wins the (ts, deviceId, seq) max is
        // recorded as a ranked tombstone so that a lower-ranked set from another
        // device cannot resurrect the entry merely by arriving later in merge
        // order. Tombstones are swept from the externally visible state at the end
        // of reduce(). This is what extends Theorem 2's order-independence from the
        // upsert sublattice to the full event set including deletes.
        bucket.set(ev.target.id, {
            data: null, ts: ev.ts, deviceId: ev.deviceId, deleted: true,
            ...(ev.seq !== undefined ? { seq: ev.seq } : {}),
        });
        return;
    }
    bucket.set(ev.target.id, {
        data: ev.after, ts: ev.ts, deviceId: ev.deviceId,
        ...(ev.seq !== undefined ? { seq: ev.seq } : {}),
    });
}
// ── byte helpers ────────────────────────────────────────────────────────────
function prefixLen(chunk) {
    return concat([u32(chunk.length >>> 0), chunk]);
}
function u16(n) {
    const a = new Uint8Array(2);
    new DataView(a.buffer).setUint16(0, n, true);
    return a;
}
function u32(n) {
    const a = new Uint8Array(4);
    new DataView(a.buffer).setUint32(0, n, true);
    return a;
}
function readU16(u8, at) {
    return new DataView(u8.buffer, u8.byteOffset + at, 2).getUint16(0, true);
}
function readU32(u8, at) {
    return new DataView(u8.buffer, u8.byteOffset + at, 4).getUint32(0, true);
}
function concat(parts) {
    let len = 0;
    for (const p of parts)
        len += p.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
function startsWith(a, b) {
    if (a.length < b.length)
        return false;
    for (let i = 0; i < b.length; i++)
        if (a[i] !== b[i])
            return false;
    return true;
}
function bytesEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
}
async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=index.js.map