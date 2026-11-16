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

/** Window-local ownership of V3 builds, independent of task events and MCP waits. */
import { settleWithin, type Clock } from './solutionApi';

export interface ManagedBuildResult {
    status: 'success' | 'failed' | 'cancelled' | 'skipped';
    exitCode?: number;
    logFile: { fsPath: string; toString(): string };
}

export interface ManagedBuildOperation {
    readonly id: string;
    readonly result: PromiseLike<ManagedBuildResult>;
    cancel(): void;
    onOutput(listener: (output: { text: string; stream: 'combined' }) => void): { dispose(): void };
}

export interface ManagedBuildEntry {
    id: string;
    action: string;
    solution: string;
    target: string;
    tail: string;
    cancellationRequested: boolean;
    result?: ManagedBuildResult;
    error?: string;
    diagnostics?: { errors: number; warnings: number };
    completedAt?: number;
    settled: Promise<void>;
    operation: ManagedBuildOperation;
}

const TAIL_CHARS = 16_384;
const RETENTION_MS = 30 * 60_000;
const COMPLETED_LIMIT = 32;

/** Retain pending operations and the latest 32 completions for thirty minutes. */
export class ManagedBuildRegistry {
    private readonly entries = new Map<string, ManagedBuildEntry>();

    public constructor(private readonly now: () => number = Date.now) { }

    private prune(): void {
        const complete = [...this.entries.values()].filter((entry) => entry.completedAt !== undefined);
        complete.sort((a, b) => a.completedAt! - b.completedAt!);
        for (const [index, entry] of complete.entries()) {
            if (this.now() - entry.completedAt! >= RETENTION_MS || index < complete.length - COMPLETED_LIMIT) {
                this.entries.delete(entry.id);
            }
        }
    }

    public get(id: string): ManagedBuildEntry | undefined {
        this.prune();
        return this.entries.get(id);
    }

    public latest(target?: string, solution?: string): ManagedBuildEntry | undefined {
        this.prune();
        return [...this.entries.values()].reverse().find((entry) =>
            (target === undefined || entry.target === target || entry.target.startsWith(`${target}@`))
            && (solution === undefined || entry.solution === solution));
    }

    public pending(): ManagedBuildEntry | undefined {
        return [...this.entries.values()].find((entry) => entry.completedAt === undefined);
    }

    public register(operation: ManagedBuildOperation, capture: { action: string; solution: string; target: string },
        completed: (entry: ManagedBuildEntry) => void = () => {}): ManagedBuildEntry {
        this.prune();
        const entry: ManagedBuildEntry = {
            ...capture, id: operation.id, operation, tail: '', cancellationRequested: false, settled: Promise.resolve(),
        };
        this.entries.set(entry.id, entry);
        let subscription: { dispose(): void } | undefined;
        // Attach both settlement handlers before any other API call can throw.
        entry.settled = Promise.resolve(operation.result).then((result) => {
            entry.result = result;
        }, (error: unknown) => {
            entry.error = error instanceof Error ? error.message : String(error);
        }).then(() => {
            entry.completedAt = this.now();
            try { subscription?.dispose(); } catch { /* Settlement remains authoritative. */ }
            try { completed(entry); } catch { /* Reporting must not change the build outcome. */ }
            this.prune();
        });
        try {
            subscription = operation.onOutput((output) => {
                entry.tail = (entry.tail + output.text).slice(-TAIL_CHARS);
            });
        } catch {
            // The original log remains authoritative if a live subscription is unavailable.
        }
        return entry;
    }

    public cancel(entry: ManagedBuildEntry): void {
        if (entry.completedAt === undefined && !entry.cancellationRequested) {
            entry.operation.cancel();
            entry.cancellationRequested = true;
        }
    }

    public async wait(entry: ManagedBuildEntry, ms: number, clock: Pick<Clock, 'startTimer'>): Promise<void> {
        await settleWithin(entry.settled, ms, clock);
    }
}

/** Shared only within this extension host; operation IDs do not survive a reload. */
export const managedBuilds = new ManagedBuildRegistry();
