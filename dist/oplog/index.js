import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encrypt, decrypt } from '../crypto/index.js';
export class OpLogWriter {
    opts;
    sessionId = randomUUID();
    buffer = [];
    flushing = false;
    constructor(opts) {
        this.opts = opts;
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
            await fs.mkdir(this.opts.dir, { recursive: true });
            await fs.appendFile(this.filePath(), Buffer.from(prefixLen(ct)));
        }
        finally {
            this.flushing = false;
            if (this.buffer.length > 0)
                void this.flush();
        }
    }
}
/**
 * Per-process memo of op-log filenames we've already warned about. The
 * sidecar may call `readAllEvents` multiple times in a session (corrections
 * counter, Activity timeline, recovery flow) — without deduplication each
 * call would re-print the same skip warnings for every stale file, which
 * spams the dev terminal and the Claude relay log with no new information.
 * Cleared when the process restarts (Set lives only in this module).
 */
const warnedOplogFiles = new Set();
export async function readAllEvents(dir, passphraseOrKey) {
    const out = [];
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
        let cursor = 0;
        let skippedChunks = 0;
        let firstSkipReason = '';
        while (cursor + 4 <= u8.length) {
            const len = new DataView(u8.buffer, u8.byteOffset + cursor, 4).getUint32(0, true);
            cursor += 4;
            // Defensive: corrupted length prefix → skip the rest of this file
            // rather than reading past the buffer. Happens if the file was
            // truncated mid-write or modified out-of-band.
            if (len === 0 || cursor + len > u8.length) {
                skippedChunks++;
                firstSkipReason = firstSkipReason || 'malformed length prefix';
                break;
            }
            const chunk = u8.subarray(cursor, cursor + len);
            cursor += len;
            // Skip chunks we can't decrypt rather than failing the whole read.
            // This happens when the op-log directory still contains files from
            // a previous passphrase (e.g., the silent-overwrite era pre-fix),
            // or when a sibling key was used. Other chunks in the same — or
            // adjacent — files may still be valid and worth returning.
            let pt;
            try {
                pt = await decrypt(chunk, passphraseOrKey);
            }
            catch (e) {
                skippedChunks++;
                firstSkipReason = firstSkipReason || (e instanceof Error ? e.message : String(e));
                continue;
            }
            const text = new TextDecoder().decode(pt);
            for (const ln of text.split('\n')) {
                if (!ln)
                    continue;
                try {
                    out.push(JSON.parse(ln));
                }
                catch {
                    // Decrypted to non-JSON: rare, treat as skipped.
                    skippedChunks++;
                    firstSkipReason = firstSkipReason || 'decrypted chunk was not valid JSON';
                }
            }
        }
        if (skippedChunks > 0 && !warnedOplogFiles.has(name)) {
            warnedOplogFiles.add(name);
            console.error(`[oplog] skipped ${skippedChunks} chunk(s) in ${name} — first reason: ${firstSkipReason}. ` +
                `Likely a leftover file from a previous passphrase or a corrupted segment; ` +
                `delete the file manually if you want this warning to stop.`);
        }
    }
    out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    return out;
}
// Deterministic merge: per (graphId, target.id, field) last-writer-wins by ts, tie-break by deviceId.
// Provenance retained — caller can read full event stream for audit.
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
    return graphs;
}
function applyEvent(g, ev) {
    const bucket = ev.target.kind === 'node' ? g.nodes :
        ev.target.kind === 'edge' ? g.edges :
            g.sources;
    const existing = bucket.get(ev.target.id);
    const wins = !existing || ev.ts > existing.ts ||
        (ev.ts === existing.ts && ev.deviceId > existing.deviceId);
    if (!wins)
        return;
    if (ev.op === 'deleteNode' || ev.op === 'deleteEdge' || ev.op === 'forgetSource') {
        bucket.delete(ev.target.id);
        return;
    }
    bucket.set(ev.target.id, { data: ev.after, ts: ev.ts, deviceId: ev.deviceId });
}
function prefixLen(chunk) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, chunk.length, true);
    const out = new Uint8Array(len.length + chunk.length);
    out.set(len, 0);
    out.set(chunk, len.length);
    return out;
}
//# sourceMappingURL=index.js.map