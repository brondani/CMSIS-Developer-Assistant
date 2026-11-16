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

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ManagedBuildRegistry, type ManagedBuildOperation, type ManagedBuildResult } from '../core/managedBuilds';
import { ProblemJournal } from '../core/problemJournal';
import { type Clock, type SolutionExtensionHandle } from '../core/solutionApi';
import { ToolError } from '../core/toolResult';
import {
    disposeManagedBuildApis,
    managedBuildApi,
    managedBuildReply,
    originalBuildTail,
    requireManagedBuild,
    submitManagedBuild,
    type ManagedBuildApi,
} from '../handler/managedBuild';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRATCH_ROOT = path.join(REPO_ROOT, '.test-artifacts', 'managed-builds');
const RETENTION_MS = 30 * 60_000;

class ManualTimerClock implements Pick<Clock, 'startTimer'> {
    private timers: Array<{ fire: () => void; cancelled: boolean }> = [];

    startTimer(_ms: number, fire: () => void): () => void {
        const timer = { fire, cancelled: false };
        this.timers.push(timer);
        return () => {
            timer.cancelled = true;
        };
    }

    fireNext(): void {
        for (;;) {
            const timer = this.timers.shift();
            if (!timer) {
                throw new Error('No pending timer to fire.');
            }
            if (!timer.cancelled) {
                timer.fire();
                return;
            }
        }
    }

    pending(): number {
        return this.timers.filter((timer) => !timer.cancelled).length;
    }
}

class ControlledOperation {
    public readonly operation: ManagedBuildOperation;
    public cancelCalls = 0;
    public disposeCalls = 0;

    private readonly listeners = new Set<(output: { text: string; stream: 'combined' }) => void>();
    private resolveResult: ((result: ManagedBuildResult) => void) | undefined;
    private rejectResult: ((error: unknown) => void) | undefined;

    constructor(id: string, private readonly throwOnOutput = false) {
        const result = new Promise<ManagedBuildResult>((resolve, reject) => {
            this.resolveResult = resolve;
            this.rejectResult = reject;
        });
        this.operation = {
            id,
            result,
            cancel: () => {
                this.cancelCalls++;
            },
            onOutput: (listener) => {
                if (this.throwOnOutput) {
                    throw new Error('onOutput unavailable');
                }
                this.listeners.add(listener);
                return {
                    dispose: () => {
                        this.disposeCalls++;
                        this.listeners.delete(listener);
                    },
                };
            },
        };
    }

    resolve(result: ManagedBuildResult): void {
        this.resolveResult?.(result);
    }

    reject(error: unknown): void {
        this.rejectResult?.(error);
    }

    emit(text: string): void {
        for (const listener of [...this.listeners]) {
            listener({ text, stream: 'combined' });
        }
    }
}

function toLogFile(fsPath: string): { fsPath: string; toString(): string } {
    return {
        fsPath,
        toString: () => `file:///${fsPath.replace(/\\/g, '/')}`,
    };
}

function writeLog(name: string, text: string): { fsPath: string; toString(): string } {
    const fsPath = path.join(SCRATCH_ROOT, name);
    fs.mkdirSync(path.dirname(fsPath), { recursive: true });
    fs.writeFileSync(fsPath, text, 'utf8');
    return toLogFile(fsPath);
}

function successfulResult(name: string, tail = ''): ManagedBuildResult {
    return { status: 'success', exitCode: 0, logFile: writeLog(name, tail || `${name} success`) };
}

function clockWithNow(): Clock {
    return {
        now: () => Date.now(),
        startTimer: (ms, fire) => {
            const handle = setTimeout(fire, Math.max(0, ms));
            return () => clearTimeout(handle);
        },
    };
}

function replyData(reply: ReturnType<typeof managedBuildReply>): { status: string; cancellationRequested: boolean } {
    return reply.data as { status: string; cancellationRequested: boolean };
}

let idCounter = 0;

function uniqueId(prefix: string): string {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
}

suite('managedBuilds', () => {
    setup(() => {
        disposeManagedBuildApis();
        fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
        fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    });

    teardown(() => {
        disposeManagedBuildApis();
        fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    });

    suite('ManagedBuildRegistry', () => {
        test('pending wait does not cancel and the same entry is retained after settlement', async () => {
            let now = 1_000;
            const clock = new ManualTimerClock();
            const registry = new ManagedBuildRegistry(() => now);
            const controlled = new ControlledOperation(uniqueId('pending'));
            const entry = registry.register(controlled.operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' });

            const waiting = registry.wait(entry, 250, clock);
            assert.strictEqual(clock.pending(), 1);
            assert.strictEqual(controlled.cancelCalls, 0);
            clock.fireNext();
            await waiting;
            assert.strictEqual(controlled.cancelCalls, 0, 'wait timeout must not cancel the managed operation');
            assert.strictEqual(entry.completedAt, undefined, 'entry remains pending until the operation settles');

            now += 10;
            const result = successfulResult('pending.log', 'pending completed naturally');
            controlled.resolve(result);
            await entry.settled;
            assert.strictEqual(registry.get(entry.id), entry, 'the registry keeps the same entry object');
            assert.deepStrictEqual(entry.result, result);
        });

        test('operation rejection is captured on the entry', async () => {
            const registry = new ManagedBuildRegistry(() => 2_000);
            const controlled = new ControlledOperation(uniqueId('reject'));
            const entry = registry.register(controlled.operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' });

            controlled.reject(new Error('managed build failed'));
            await entry.settled;

            assert.strictEqual(entry.result, undefined);
            assert.strictEqual(entry.error, 'managed build failed');
            assert.ok(entry.completedAt !== undefined);
        });

        test('cancellation race keeps natural success authoritative', async () => {
            const registry = new ManagedBuildRegistry(() => 3_000);
            const controlled = new ControlledOperation(uniqueId('cancel-race'));
            const entry = registry.register(controlled.operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' });

            registry.cancel(entry);
            registry.cancel(entry);
            assert.strictEqual(controlled.cancelCalls, 1, 'duplicate cancellation requests are ignored');

            controlled.resolve(successfulResult('cancel-race.log', 'success after cancel request'));
            await entry.settled;
            const reply = managedBuildReply(entry);

            assert.match(reply.text, /: success\./);
            assert.match(reply.text, /Cancellation requested; the settled result decides the outcome\./);
            assert.strictEqual(replyData(reply).status, 'success');
            assert.strictEqual(replyData(reply).cancellationRequested, true);
        });

        test('skipped status stays distinct from success', async () => {
            const registry = new ManagedBuildRegistry(() => 4_000);
            const controlled = new ControlledOperation(uniqueId('skipped'));
            const entry = registry.register(controlled.operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' });

            controlled.resolve({ status: 'skipped', exitCode: 0, logFile: writeLog('skipped.log', 'duplicate request skipped') });
            await entry.settled;
            const reply = managedBuildReply(entry);

            assert.match(reply.text, /: skipped\./);
            assert.match(reply.text, /Queued duplicate discarded; this is not a successful build and does not report another operation’s result\./);
            assert.strictEqual(replyData(reply).status, 'skipped');
        });

        test('tail is bounded and the output subscription is disposed at settlement', async () => {
            const registry = new ManagedBuildRegistry(() => 5_000);
            const controlled = new ControlledOperation(uniqueId('tail'));
            const entry = registry.register(controlled.operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' });

            const combined = `${'A'.repeat(17_000)}XYZ`;
            controlled.emit(combined);
            assert.strictEqual(entry.tail, combined.slice(-16_384));

            controlled.resolve(successfulResult('tail.log', 'tail done'));
            await entry.settled;
            assert.strictEqual(controlled.disposeCalls, 1);
        });

        test('completion callback failure does not override the build result', async () => {
            const registry = new ManagedBuildRegistry(() => 6_000);
            const controlled = new ControlledOperation(uniqueId('callback-throws'));
            let callbackCalls = 0;
            const entry = registry.register(controlled.operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' }, () => {
                callbackCalls += 1;
                throw new Error('observer failed');
            });

            controlled.resolve(successfulResult('callback.log', 'callback test'));
            await entry.settled;

            assert.strictEqual(callbackCalls, 1);
            assert.strictEqual(entry.result?.status, 'success');
            assert.strictEqual(entry.error, undefined);
        });

        test('completed entries are capped at 32 and expire after retention', async () => {
            let now = 10_000;
            const registry = new ManagedBuildRegistry(() => now);
            for (let index = 1; index <= 35; index++) {
                const id = `completed-${index}`;
                const operation: ManagedBuildOperation = {
                    id,
                    result: Promise.resolve({ status: 'success', exitCode: 0, logFile: writeLog(`${id}.log`, id) }),
                    cancel: () => undefined,
                    onOutput: () => ({ dispose: () => undefined }),
                };
                const entry = registry.register(operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' });
                await entry.settled;
                now += 1;
            }

            assert.strictEqual(registry.get('completed-1'), undefined);
            assert.strictEqual(registry.get('completed-2'), undefined);
            assert.strictEqual(registry.get('completed-3'), undefined);
            assert.ok(registry.get('completed-4'));
            assert.ok(registry.get('completed-35'));

            now += RETENTION_MS + 1;
            assert.strictEqual(registry.latest(), undefined);
        });
    });

    suite('managedBuild handler integration', () => {
        test('managedBuildApi caches by extension exports and disposal resets ownership', async () => {
            const clock = clockWithNow();
            let activations = 0;
            let asks = 0;
            let disposeCalls = 0;
            const api: ManagedBuildApi = {
                build: () => {
                    throw new Error('not used in this test');
                },
                dispose: () => {
                    disposeCalls += 1;
                },
            };
            const surface = {
                getApi: (version: number): unknown => {
                    asks += 1;
                    assert.strictEqual(version, 3);
                    return api;
                },
            };
            const handle: SolutionExtensionHandle = {
                isActive: false,
                exports: surface,
                activate: async (): Promise<unknown> => {
                    activations += 1;
                    (handle as { isActive: boolean }).isActive = true;
                    return surface;
                },
            };

            assert.strictEqual(await managedBuildApi(handle, clock, 500), api);
            assert.strictEqual(await managedBuildApi(handle, clock, 500), api);
            assert.deepStrictEqual([activations, asks], [1, 1]);

            disposeManagedBuildApis();
            assert.strictEqual(disposeCalls, 1);
            assert.strictEqual(await managedBuildApi(handle, clock, 500), api);
            assert.strictEqual(asks, 2);
        });

        test('managedBuildApi falls back to legacy paths when API V3 is unavailable', async () => {
            const clock = clockWithNow();

            assert.strictEqual(await managedBuildApi(undefined, clock, 500), undefined);

            const noSurface: SolutionExtensionHandle = {
                isActive: true,
                exports: {},
                activate: async (): Promise<unknown> => ({}),
            };
            assert.strictEqual(await managedBuildApi(noSurface, clock, 500), undefined);

            let throwCalls = 0;
            const throwing = {
                getApi: (_version: number): unknown => {
                    throwCalls += 1;
                    throw new Error('no API 3');
                },
            };
            const throwingHandle: SolutionExtensionHandle = {
                isActive: true,
                exports: throwing,
                activate: async (): Promise<unknown> => throwing,
            };
            assert.strictEqual(await managedBuildApi(throwingHandle, clock, 500), undefined);
            assert.strictEqual(await managedBuildApi(throwingHandle, clock, 500), undefined);
            assert.strictEqual(throwCalls, 1, 'missing V3 API is cached per exports object');

            let wrongCalls = 0;
            const wrong = {
                getApi: (_version: number): unknown => {
                    wrongCalls += 1;
                    return { dispose: () => undefined };
                },
            };
            const wrongHandle: SolutionExtensionHandle = {
                isActive: true,
                exports: wrong,
                activate: async (): Promise<unknown> => wrong,
            };
            assert.strictEqual(await managedBuildApi(wrongHandle, clock, 500), undefined);
            assert.strictEqual(await managedBuildApi(wrongHandle, clock, 500), undefined);
            assert.strictEqual(wrongCalls, 1);
        });

        test('managedBuildApi times out while activation stays pending', async () => {
            const clock = new ManualTimerClock();
            const handle: SolutionExtensionHandle = {
                isActive: false,
                exports: {},
                activate: () => new Promise<unknown>(() => undefined),
            };
            const pending = managedBuildApi(handle, { now: () => 0, startTimer: clock.startTimer.bind(clock) }, 200);
            clock.fireNext();

            await assert.rejects(pending, (error: unknown) =>
                error instanceof ToolError && error.code === 'TIMEOUT' && /activation is still pending/.test(error.message));
        });

        test('submitManagedBuild keeps pending operations alive and requireManagedBuild finds the same entry', async () => {
            const operationId = uniqueId('submit-pending');
            const controlled = new ControlledOperation(operationId);
            const api: ManagedBuildApi = { build: () => controlled.operation };
            const clock = new ManualTimerClock();
            const journal = new ProblemJournal(() => 20_000);

            const pending = submitManagedBuild(api, 'build', 'demo.csolution.yml', 'MPS3', journal, 300, {
                now: () => 20_000,
                startTimer: clock.startTimer.bind(clock),
            });
            clock.fireNext();
            const reply = await pending;

            assert.strictEqual(reply.status, 'running');
            assert.match(reply.text, /Use status with this operationId to wait; the wait deadline does not cancel or restart the build\./);
            assert.strictEqual(controlled.cancelCalls, 0);

            const retained = requireManagedBuild(operationId);
            assert.strictEqual(retained.id, operationId);
            controlled.resolve(successfulResult('submit-pending.log', 'finished after pending wait'));
            await retained.settled;
            assert.strictEqual(requireManagedBuild(operationId), retained);
            assert.strictEqual(journal.query({ minSeverity: 'info' }).records.length, 0);
        });

        test('concurrent submissions join the captured operation and refuse a different action', async () => {
            const controlled = new ControlledOperation(uniqueId('concurrent'));
            let builds = 0;
            const api: ManagedBuildApi = { build: () => { builds++; return controlled.operation; } };
            const journal = new ProblemJournal();
            const first = submitManagedBuild(api, 'build', 'demo.csolution.yml', 'MPS3', journal, 1_000, clockWithNow());
            const second = submitManagedBuild(api, 'build', 'demo.csolution.yml', 'MPS3', journal, 1_000, clockWithNow());
            try {
                await assert.rejects(submitManagedBuild(api, 'clean', 'demo.csolution.yml', 'MPS3', journal, 1_000, clockWithNow()), /pending/);
                assert.strictEqual(builds, 1);
            } finally {
                controlled.resolve(successfulResult('concurrent.log', 'done'));
                const replies = await Promise.all([first, second]);
                assert.strictEqual(replies[0].text, replies[1].text);
            }
        });

        test('malformed operation never causes a replacement submission', async () => {
            let builds = 0;
            const api: ManagedBuildApi = { build: () => {
                builds++;
                return { id: 'malformed', result: Promise.reject(new Error('logging failed')) } as unknown as ManagedBuildOperation;
            } };
            await assert.rejects(submitManagedBuild(api, 'build', 'demo.csolution.yml', 'MPS3', new ProblemJournal(), 100, clockWithNow()), /no replacement build/);
            assert.strictEqual(builds, 1);
        });

        test('submitManagedBuild reports rejection and keeps the failure in the problem journal', async () => {
            const operationId = uniqueId('submit-reject');
            const controlled = new ControlledOperation(operationId);
            const api: ManagedBuildApi = { build: () => controlled.operation };
            const journal = new ProblemJournal(() => 21_000);

            const pending = submitManagedBuild(api, 'build', 'demo.csolution.yml', 'MPS3', journal, 1_000, clockWithNow());
            controlled.reject(new Error('transport failed'));
            const reply = await pending;

            assert.strictEqual(reply.status, 'ok');
            assert.match(reply.text, /: error\./);
            assert.match(reply.text, /Infrastructure\/logging failure: transport failed/);
            const records = journal.query({ sources: ['build'], minSeverity: 'error' }).records;
            assert.strictEqual(records.length, 1);
            assert.strictEqual(records[0].message, 'transport failed');
        });

        test('originalBuildTail uses file tail and falls back to retained live output when unreadable', () => {
            const registry = new ManagedBuildRegistry(() => 30_000);
            const controlled = new ControlledOperation(uniqueId('tail-source'));
            const entry = registry.register(controlled.operation, { action: 'build', solution: 'demo.csolution.yml', target: 'MPS3' });
            const file = writeLog('tail-source.log', `${'x'.repeat(400)}${'y'.repeat(220)}`);
            entry.result = { status: 'success', exitCode: 0, logFile: file };
            entry.tail = 'live output ignored when original log exists';

            assert.strictEqual(originalBuildTail(entry, 200), 'y'.repeat(200));

            entry.result = { status: 'success', exitCode: 0, logFile: toLogFile(path.join(SCRATCH_ROOT, 'missing.log')) };
            entry.tail = 'retained-live-tail';
            const fallback = originalBuildTail(entry, 12);
            assert.match(fallback, /^ed-live-tail\n\[Original log unavailable; showing retained live output\.\]$/);
        });

        test('requireManagedBuild rejects unknown IDs', () => {
            assert.throws(() => requireManagedBuild('managed-build-test-missing-id'), (error: unknown) =>
                error instanceof ToolError && error.code === 'INVALID_ARGUMENT' && /Unknown or expired build operation/.test(error.message));
        });
    });
});

