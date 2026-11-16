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

// Exercise production routing with real VS Code commands and the observed V3 API.
const path = require('node:path');

exports.createBridge = async ({ api, repository, workspace }) => {
    const load = file => require(path.join(repository, 'out', 'src', file));
    const { runCmsisAction } = load('handler/cmsisAction.js');
    const { VSCODE_HOST } = load('handler/host.js');
    const { ProblemJournal } = load('core/problemJournal.js');
    const { BuildInfoHandler } = load('buildInfoHandler.js');
    const { disposeManagedBuildApis } = load('handler/managedBuild.js');
    const { attachBuildDiagnosis, vscodeDiagnosisHost } = load('cmsisBuildDiagnosis.js');
    const { windowJobTracker } = load('cmsisJobTracker.js');
    let legacyReruns = 0;
    const diagnosisHost = vscodeDiagnosisHost(VSCODE_HOST.clock);
    const diagnosis = attachBuildDiagnosis(windowJobTracker(), {
        ...diagnosisHost,
        spawn: (...args) => {
            legacyReruns++;
            return diagnosisHost.spawn(...args);
        },
    });
    const assertNoLegacyRerun = () => {
        if (legacyReruns !== 0) {
            throw new Error(`Managed build triggered ${legacyReruns} legacy diagnostic reruns`);
        }
    };
    const handle = { isActive: true, exports: { getApi: () => api } };
    const journal = new ProblemJournal();
    const buildInfo = new BuildInfoHandler({
        workspaceFolders: () => [workspace],
        activeContext: async () => ({ solutionFile: await api.getSolutionFile(), targetType: await api.getActiveTarget() }),
        log: { info() {}, warn() {}, error() {}, debug() {} },
    }, { timeoutMs: 10_000, workspaceRoot: () => workspace });
    const context = {
        host: { ...VSCODE_HOST, solutionExtension: () => handle },
        executor: { hasDebugSession: () => false },
        journal,
    };
    return {
        dispose: () => { diagnosis.dispose(); disposeManagedBuildApis(); assertNoLegacyRerun(); },
        action: async ({ action, timeoutMs, operationId }) => {
            const reply = await runCmsisAction(context, action, undefined, timeoutMs,
                undefined, undefined, undefined, undefined, operationId);
            assertNoLegacyRerun();
            return typeof reply === 'string' ? reply : reply.text;
        },
        diagnostics: async operationId => {
            const reply = await buildInfo.handleGetBuildDiagnostics({ operationId });
            return typeof reply === 'string' ? reply : reply.text;
        },
    };
};
