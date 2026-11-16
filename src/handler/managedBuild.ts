/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Managed V3 submission and replies: the operation result, never a task exit, is authoritative. */
import * as fs from 'fs';
import { readBuildLog } from '../core/buildInfo/buildLog';
import { managedBuilds, type ManagedBuildEntry, type ManagedBuildOperation } from '../core/managedBuilds';
import type { ProblemJournal } from '../core/problemJournal';
import { settleWithin, type Clock, type SolutionExtensionHandle } from '../core/solutionApi';
import { ToolError, type ToolReply } from '../core/toolResult';

export interface ManagedBuildApi {
    build(options: { clean: boolean; rebuild: boolean; updateRte: boolean; packs: boolean }): ManagedBuildOperation;
    dispose?(): void;
}

let apis = new WeakMap<object, ManagedBuildApi | null>();
const OWNED_APIS = new Set<ManagedBuildApi>();

/** Release the API instances owned by this extension host on deactivation. */
export function disposeManagedBuildApis(): void {
    for (const api of OWNED_APIS) {
        try { api.dispose?.(); } catch { /* Continue releasing the remaining instances. */ }
    }
    OWNED_APIS.clear();
    apis = new WeakMap();
}

/** Acquire once per extension exports object; old extensions keep the task backend. */
export async function managedBuildApi(handle: SolutionExtensionHandle | undefined, clock: Clock, ms: number): Promise<ManagedBuildApi | undefined> {
    if (!handle) { return undefined; }
    let exported = handle.exports;
    if (!handle.isActive) {
        const activation = await settleWithin(handle.activate(), ms, clock);
        if (!activation) { throw new ToolError('TIMEOUT', 'CMSIS Solution activation is still pending; no build was submitted.'); }
        exported = activation.value ?? handle.exports;
    }
    const surface = exported as { getApi?: (version: number) => unknown } | undefined;
    if (!surface || typeof surface.getApi !== 'function') { return undefined; }
    if (apis.has(surface)) { return apis.get(surface) ?? undefined; }
    let api: unknown;
    try { api = surface.getApi(3); } catch { apis.set(surface, null); return undefined; }
    if (!api || typeof (api as ManagedBuildApi).build !== 'function') {
        apis.set(surface, null);
        return undefined;
    }
    apis.set(surface, api as ManagedBuildApi);
    OWNED_APIS.add(api as ManagedBuildApi);
    return api as ManagedBuildApi;
}

/** Look up an explicit operation without silently falling back to a different build. */
export function requireManagedBuild(id: string): ManagedBuildEntry {
    const entry = managedBuilds.get(id);
    if (!entry) {
        throw new ToolError('INVALID_ARGUMENT', `Unknown or expired build operation '${id}'. Operations expire after 30 minutes, 32 completions, or a window reload. No build was started.`);
    }
    return entry;
}

/** Bounded original output, including messages emitted before the live listener attached. */
export function originalBuildTail(entry: ManagedBuildEntry, maxChars = 16_384): string {
    const file = entry.result?.logFile.fsPath;
    if (!file) { return entry.tail.slice(-maxChars); }
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, maxChars * 4));
        const read = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        return buffer.subarray(0, read).toString('utf8').slice(-maxChars);
    } catch {
        return `${entry.tail.slice(-maxChars)}\n[Original log unavailable; showing retained live output.]`;
    } finally {
        if (fd !== undefined) { fs.closeSync(fd); }
    }
}

/** Render authoritative status separately from the transport's pending marker. */
export function managedBuildReply(entry: ManagedBuildEntry): ToolReply {
    const status = entry.error ? 'error' : entry.result?.status ?? 'pending';
    const text = [`CMSIS '${entry.action}' on ${entry.target || '(none)'}: ${status}.`,
        `Operation: ${entry.id}`, `Solution: ${entry.solution}`];
    if (entry.cancellationRequested) { text.push('Cancellation requested; the settled result decides the outcome.'); }
    if (entry.result?.exitCode !== undefined) { text.push(`Exit code: ${entry.result.exitCode}`); }
    if (entry.result) { text.push(`Original log: ${entry.result.logFile.fsPath}\nLog URI: ${entry.result.logFile.toString()}`); }
    if (entry.diagnostics) { text.push(`Diagnostics: ${entry.diagnostics.errors} error(s), ${entry.diagnostics.warnings} warning(s).`); }
    if (entry.error) { text.push(`Infrastructure/logging failure: ${entry.error}`); }
    if (status === 'skipped') { text.push('Queued duplicate discarded; this is not a successful build and does not report another operation’s result.'); }
    if (status === 'pending') { text.push('Use status with this operationId to wait; the wait deadline does not cancel or restart the build.'); }
    const tail = originalBuildTail(entry);
    if (tail) { text.push(`Original output (bounded tail):\n${tail}`); }
    return { text: text.join('\n'), status: status === 'pending' ? 'running' : 'ok',
        data: { operationId: entry.id, status, solution: entry.solution, target: entry.target,
            cancellationRequested: entry.cancellationRequested, ...(entry.result?.exitCode !== undefined ? { exitCode: entry.result.exitCode } : {}) } };
}

/** Submit exactly once, retaining the result and journal diagnostics even after the caller times out. */
export async function submitManagedBuild(api: ManagedBuildApi, action: string, solution: string, target: string,
    journal: ProblemJournal, ms: number, clock: Clock): Promise<ToolReply> {
    const pending = managedBuilds.pending();
    if (pending) {
        if (pending.action !== action || pending.solution !== solution || pending.target !== target) {
            throw new ToolError('TASK_FAILED', `Build operation ${pending.id} is pending; wait for it before submitting another build.`);
        }
        await managedBuilds.wait(pending, ms, clock);
        return managedBuildReply(pending);
    }
    const operation = api.build({ clean: action === 'clean', rebuild: action === 'rebuild', updateRte: false, packs: false });
    if (!operation || typeof operation.id !== 'string' || !operation.result || typeof operation.result.then !== 'function'
        || typeof operation.onOutput !== 'function' || typeof operation.cancel !== 'function') {
        // A mismatched API may already have submitted work: observe rejection, never retry.
        void Promise.resolve(operation?.result ?? operation).catch(() => {});
        throw new ToolError('TASK_FAILED', 'CMSIS Solution API V3 returned no managed operation. Update the extension; no replacement build was submitted.');
    }
    const entry = managedBuilds.register(operation, { action, solution, target }, (done) => {
        const origin = `CMSIS ${done.id}: ${done.solution} (${done.target})`;
        if (done.error || done.result?.status === 'failed') {
            journal.append({ source: 'build', severity: 'error', origin, message: done.error ?? `Build failed (exit ${done.result?.exitCode ?? 'unknown'}).` });
        }
        if (done.result) {
            try {
                const summary = readBuildLog(done.result.logFile.fsPath);
                done.diagnostics = { errors: summary.errors, warnings: summary.warnings };
                for (const diagnostic of summary.diagnostics) {
                    if (diagnostic.severity !== 'note') {
                        journal.append({ source: 'build', origin, severity: diagnostic.severity, message: diagnostic.message,
                            ...(diagnostic.file ? { location: { file: diagnostic.file, line: diagnostic.line, column: diagnostic.col } } : {}) });
                    }
                }
            } catch { /* A cleaned-up log must not hide the authoritative build result. */ }
        }
    });
    await managedBuilds.wait(entry, ms, clock);
    return managedBuildReply(entry);
}
