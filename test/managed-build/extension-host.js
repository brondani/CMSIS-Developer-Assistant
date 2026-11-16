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

// Executed by VS Code itself, never by a vscode stub or a shell build tool.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const BUILD_TIMEOUT_MS = 120_000;

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function deadline(promise, milliseconds, description, cancel) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    cancel?.();
                    reject(new Error(`${description} timed out after ${milliseconds} ms`));
                }, milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function artifacts(directory) {
    const found = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...await artifacts(filename));
        } else if (/\.(a|lib)$/i.test(filename)) {
            const stat = await fs.stat(filename);
            found.push({ filename, size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
    return found.sort((left, right) => left.filename.localeCompare(right.filename));
}

/** Entry point required by @vscode/test-electron's extensionTestsPath. */
exports.run = async function run() {
    const configurationFile = process.env.CMSIS_MANAGED_BUILD_CONFIGURATION;
    assert.ok(configurationFile, 'Use the opt-in test\\managed-build\\run.js launcher.');
    const configuration = JSON.parse(await fs.readFile(configurationFile, 'utf8'));
    const report = { startedAt: new Date().toISOString(), configuration, cases: [] };
    const taskStarts = new Map();
    const activeOperations = new Set();
    const taskSubscription = vscode.tasks.onDidStartTask(event => {
        const id = event.execution.task.definition.operationId;
        if (id) {
            taskStarts.set(id, (taskStarts.get(id) || 0) + 1);
        }
    });
    let api;
    let bridge;
    let failure;
    const sourceFile = path.join(configuration.workspace, 'managed-build.c');
    const originalSource = await fs.readFile(sourceFile, 'utf8');

    async function test(name, execute) {
        const startedAt = Date.now();
        try {
            const details = await execute();
            report.cases.push({ name, status: 'passed', durationMs: Date.now() - startedAt, details });
            console.log(`PASS ${name}`);
            return details;
        } catch (error) {
            report.cases.push({ name, status: 'failed', durationMs: Date.now() - startedAt,
                error: error instanceof Error ? error.stack : String(error) });
            console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`);
            throw error;
        }
    }

    function observe(operation, allowSharedTaskEvent = false) {
        assert.equal(typeof operation?.then, 'undefined', 'V3 build must return immediately, not a promise (old API installed?).');
        assert.equal(typeof operation.id, 'string');
        assert.ok(operation.id.length > 0);
        assert.equal(typeof operation.cancel, 'function');
        assert.equal(typeof operation.onOutput, 'function');
        const completion = operation.result;
        assert.ok(completion && typeof completion.then === 'function');
        assert.equal(operation.result, completion, 'Completion promise must be stable.');
        const output = [];
        const subscription = operation.onOutput(event => output.push(event));
        activeOperations.add(operation);
        // Observe rejections immediately, including requests submitted in a burst.
        const observed = completion.then(result => ({ result }), error => ({ error }));
        return {
            operation,
            async finish() {
                try {
                    const outcome = await deadline(observed, BUILD_TIMEOUT_MS, `Build ${operation.id}`, () => operation.cancel());
                    if (outcome.error) {
                        throw outcome.error;
                    }
                    const result = outcome.result;
                    assert.equal(await operation.result, result, 'Late consumers must receive the original result.');
                    const bytes = await vscode.workspace.fs.readFile(result.logFile);
                    const log = Buffer.from(bytes).toString('utf8');
                    assert.equal(log, output.map(event => event.text).join(''), 'Saved original log must equal every live output byte.');
                    for (let index = 0; index < output.length; index += 1) {
                        assert.equal(output[index].stream, 'combined');
                        assert.ok(Number.isFinite(output[index].timestamp));
                        assert.ok(output[index].sequence > (output[index - 1]?.sequence || 0));
                    }
                    const relativeLog = path.relative(path.join(configuration.runDirectory, 'scratch'), result.logFile.fsPath);
                    assert.ok(relativeLog && !relativeLog.startsWith('..') && !path.isAbsolute(relativeLog),
                        'Original logs must stay in this run\'s isolated scratch area.');
                    const details = { id: operation.id, status: result.status, exitCode: result.exitCode,
                        logFile: result.logFile.fsPath, bytes: bytes.length, outputChunks: output.length,
                        taskStarts: taskStarts.get(operation.id) || 0,
                        taskOperationId: operation.taskExecution?.task.definition.operationId };
                    report.operations ||= [];
                    report.operations.push(details);
                    if (result.status === 'success' || result.status === 'failed') {
                        assert.ok(operation.taskExecution, 'Executed builds must expose the VS Code task execution.');
                        if (allowSharedTaskEvent) {
                            assert.ok(details.taskStarts <= 1, 'A managed request must not start a diagnostic rerun.');
                        } else {
                            assert.equal(details.taskStarts, 1, 'One original managed task, not a diagnostic rerun.');
                        }
                        if (result.status === 'success' || result.exitCode !== undefined) {
                            assert.ok(log.length > 0, 'An executed build must preserve its original output.');
                        }
                    }
                    return { result, log, details };
                } finally {
                    subscription.dispose();
                    activeOperations.delete(operation);
                }
            },
        };
    }

    function submit(options = {}, allowSharedTaskEvent = false) {
        return observe(api.build({ packs: false, updateRte: false, ...options }), allowSharedTaskEvent);
    }

    try {
        await test('installed extension, V3 API and isolated workspace', async () => {
            assert.equal(vscode.workspace.workspaceFolders?.length, 1);
            assert.equal(path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath).toLowerCase(),
                path.resolve(configuration.workspace).toLowerCase());
            const extension = vscode.extensions.getExtension('Arm.cmsis-csolution');
            assert.ok(extension, 'Installed CMSIS Solution must be visible.');
            assert.equal(path.resolve(extension.extensionPath).toLowerCase(), path.resolve(configuration.solutionExtension).toLowerCase(),
                'VS Code must load the selected installed extension, not another installed version.');
            const exports = await deadline(extension.activate(), 60_000, 'CMSIS Solution activation');
            assert.equal(typeof exports.getApi, 'function');
            api = exports.getApi(3);
            assert.equal(typeof api.build, 'function');
            assert.equal(typeof api.activateSolution, 'function');
            const solutionFile = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'ManagedBuild.csolution.yml');
            await deadline(api.activateSolution(solutionFile), 60_000, 'Disposable solution activation');
            const ready = async () => {
                while ((await api.getTargets()).length === 0) {
                    await delay(100);
                }
            };
            await deadline(ready(), 60_000, 'Disposable solution loading');
            assert.equal(path.resolve(await api.getSolutionFile()).toLowerCase(), path.resolve(solutionFile).toLowerCase());
            report.activeTarget = await api.getActiveTarget();
            report.toolchains = await api.getToolchains();
            return { extensionPath: extension.extensionPath, version: extension.packageJSON.version,
                target: report.activeTarget, toolchains: report.toolchains };
        });

        await test('real successful build and complete original log', async () => {
            const { result, log, details } = await submit().finish();
            assert.equal(result.status, 'success', log);
            assert.equal(result.exitCode, 0, log);
            const images = await artifacts(configuration.workspace);
            assert.ok(images.length > 0, 'The fixture must produce a real static library.');
            assert.ok(images.every(image => image.size > 0));
            return { ...details, artifacts: images };
        });

        await test('no-op build keeps artifact timestamps and its original log', async () => {
            const before = await artifacts(configuration.workspace);
            await delay(1100);
            const { result, log, details } = await submit().finish();
            assert.equal(result.status, 'success', log);
            assert.equal(result.exitCode, 0, log);
            assert.match(log, /no work to do|nothing to be done|up.to.date/i, 'The second build must actually be a no-op.');
            assert.deepEqual(await artifacts(configuration.workspace), before, 'A successful no-op must not rewrite its library.');
            return details;
        });

        await test('compiler failure resolves with original nonzero exit and log', async () => {
            await fs.writeFile(sourceFile, `${originalSource}\n#error CDA_MANAGED_BUILD_INTENTIONAL_FAILURE_713\n`);
            try {
                const { result, log, details } = await submit().finish();
                assert.equal(result.status, 'failed', log);
                assert.equal(typeof result.exitCode, 'number', log);
                assert.notEqual(result.exitCode, 0, log);
                assert.match(log, /CDA_MANAGED_BUILD_INTENTIONAL_FAILURE_713/);
                return details;
            } finally {
                await fs.writeFile(sourceFile, originalSource);
            }
        });

        await test('already-aborted submission cancels without execution', async () => {
            const controller = new AbortController();
            controller.abort();
            const pending = submit({ signal: controller.signal });
            pending.operation.cancel();
            pending.operation.cancel();
            const { result, log, details } = await pending.finish();
            assert.equal(result.status, 'cancelled');
            assert.equal(result.exitCode, undefined);
            assert.equal(log, '');
            assert.equal(details.taskStarts, 0);
            return details;
        });

        if (configuration.queuedDuplicates) {
            await test('queued identical requests resolve skipped independently', async () => {
                const requests = Array.from({ length: 5 }, () => submit({ rebuild: true }, true));
                assert.equal(new Set(requests.map(request => request.operation.id)).size, requests.length);
                const outcomes = await Promise.all(requests.map(request => request.finish()));
                assert.ok(outcomes.some(outcome => outcome.result.status === 'skipped'),
                    `Expected a skipped duplicate; actual statuses: ${outcomes.map(outcome => outcome.result.status).join(', ')}`);
                for (const { result, log } of outcomes) {
                    if (result.status === 'skipped') {
                        assert.equal(result.exitCode, undefined);
                        assert.equal(log, '');
                    } else {
                        assert.equal(result.status, 'success', log);
                        assert.equal(result.exitCode, 0, log);
                    }
                }
                return outcomes.map(outcome => outcome.details);
            });
        }

        if (configuration.bridge) {
            const observed = [];
            const observedApi = new Proxy(api, {
                get(target, property) {
                    if (property === 'build') {
                        return options => {
                            const operation = target.build(options);
                            observed.push(observe(operation));
                            return operation;
                        };
                    }
                    const value = Reflect.get(target, property);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            bridge = await require(configuration.bridge).createBridge({
                vscode, api: observedApi, workspace: configuration.workspace, repository: configuration.repository,
            });
            assert.equal(typeof bridge.action, 'function');
            for (const scenario of ['success', 'no-op', 'failure']) {
                await test(`CDA cmsis_action real ${scenario}`, async () => {
                    if (scenario === 'failure') {
                        await fs.writeFile(sourceFile, `${originalSource}\n#error CDA_MANAGED_BUILD_INTENTIONAL_FAILURE_713\n`);
                    }
                    const offset = observed.length;
                    try {
                        const reply = await deadline(bridge.action({ action: 'build', timeoutMs: BUILD_TIMEOUT_MS }),
                            BUILD_TIMEOUT_MS + 10_000, 'CDA managed build');
                        assert.equal(observed.length, offset + 1, 'CDA must submit exactly one real V3 managed build.');
                        const { result, log, details } = await observed[offset].finish();
                        assert.equal(result.status, scenario === 'failure' ? 'failed' : 'success', log);
                        assert.ok(typeof reply === 'string' && reply.length > 0, 'Bridge must return the actual agent-visible reply.');
                        assert.ok(reply.includes(result.logFile.fsPath), 'CDA reply must name the original operation log.');
                        if (scenario === 'no-op') {
                            assert.match(log, /no work to do|nothing to be done|up.to.date/i);
                        }
                        if (scenario === 'failure') {
                            assert.match(log, /CDA_MANAGED_BUILD_INTENTIONAL_FAILURE_713/);
                            assert.match(reply, /fail|❌/i);
                            const diagnostics = await bridge.diagnostics(details.id);
                            assert.match(diagnostics, /CDA_MANAGED_BUILD_INTENTIONAL_FAILURE_713/);
                            assert.match(await bridge.diagnostics(), /CDA_MANAGED_BUILD_INTENTIONAL_FAILURE_713/);
                            assert.equal(observed.length, offset + 1, 'Diagnostics must not rebuild.');
                        } else {
                            assert.match(reply, /success|✅/i);
                        }
                        return { ...details, reply };
                    } finally {
                        if (scenario === 'failure') {
                            await fs.writeFile(sourceFile, originalSource);
                        }
                    }
                });
            }
            for (const action of ['clean', 'rebuild']) {
                await test(`CDA cmsis_action real ${action}`, async () => {
                    const offset = observed.length;
                    const reply = await bridge.action({ action, timeoutMs: BUILD_TIMEOUT_MS });
                    assert.equal(observed.length, offset + 1);
                    const { result, log, details } = await observed[offset].finish();
                    assert.equal(result.status, 'success', log);
                    assert.match(reply, /success/);
                    assert.ok(reply.includes(result.logFile.fsPath));
                    return { ...details, reply };
                });
            }
            await test('CDA pending wait, status and cancellation retain one operation', async () => {
                const offset = observed.length;
                const pending = await bridge.action({ action: 'rebuild', timeoutMs: 100 });
                assert.equal(observed.length, offset + 1);
                const request = observed[offset];
                assert.match(pending, /pending/);
                assert.ok(pending.includes(request.operation.id));
                const joined = await bridge.action({ action: 'rebuild', timeoutMs: 100 });
                assert.ok(joined.includes(request.operation.id));
                assert.equal(observed.length, offset + 1, 'Repeated pending request must join, not resubmit.');
                const status = await bridge.action({ action: 'status', timeoutMs: 100, operationId: request.operation.id });
                assert.ok(status.includes(request.operation.id));
                const cancelled = await bridge.action({ action: 'stop_build', timeoutMs: BUILD_TIMEOUT_MS, operationId: request.operation.id });
                const { result, details } = await request.finish();
                assert.ok(['cancelled', 'success', 'failed'].includes(result.status));
                assert.ok(cancelled.includes(result.status));
                assert.equal(observed.length, offset + 1, 'Status/cancel must not submit a replacement.');
                return { ...details, pending, status, cancelled };
            });
        } else {
            report.cases.push({ name: 'CDA adapter integration', status: 'not-run',
                reason: 'Pass --cda-bridge <module> to exercise the actual CDA handler; raw V3 API coverage is not CDA coverage.' });
        }
        await test('solution and target selection remain unchanged', async () => {
            assert.equal(await api.getActiveTarget(), report.activeTarget);
            assert.equal(path.resolve(await api.getSolutionFile()).toLowerCase(),
                path.resolve(configuration.workspace, 'ManagedBuild.csolution.yml').toLowerCase());
        });
    } catch (error) {
        failure = error;
    } finally {
        for (const operation of activeOperations) {
            operation.cancel();
        }
        try {
            await bridge?.dispose?.();
            await api?.deactivateSolution();
        } catch (error) {
            failure ||= error;
        } finally {
            api?.dispose();
            taskSubscription.dispose();
            await fs.writeFile(sourceFile, originalSource);
            report.finishedAt = new Date().toISOString();
            report.status = failure ? 'failed' : 'passed';
            await fs.writeFile(path.join(configuration.runDirectory, 'results.json'), JSON.stringify(report, null, 2));
        }
    }
    if (failure) {
        throw failure;
    }
};
