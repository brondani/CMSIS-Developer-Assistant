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

// Opt-in launcher for the real, installed CMSIS Solution V3 extension API.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Writable } = require('node:stream');
const { runTests } = require('@vscode/test-electron');

const repository = path.resolve(__dirname, '..', '..');

function argument(name) {
    const index = process.argv.indexOf(name);
    if (index < 0) {
        return undefined;
    }
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
    }
    return path.resolve(value);
}

function findSolutionExtension(extensionsDirectory) {
    const candidates = fs.readdirSync(extensionsDirectory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^arm\.cmsis-csolution-/i.test(entry.name))
        .map(entry => path.join(extensionsDirectory, entry.name))
        .filter(directory => {
            const bundle = path.join(directory, 'dist', 'extension.js');
            return fs.existsSync(bundle) && fs.readFileSync(bundle, 'utf8').includes('onOutput');
        })
        .sort((left, right) => fs.statSync(path.join(right, 'dist', 'extension.js')).mtimeMs
            - fs.statSync(path.join(left, 'dist', 'extension.js')).mtimeMs);
    if (!candidates[0]) {
        throw new Error('No installed CMSIS Solution with managed-build output found. Pass --solution-extension <installed folder> with PR #713.');
    }
    return candidates[0];
}

function findCode() {
    const cache = path.join(repository, '.vscode-test');
    const executable = process.platform === 'win32' ? 'Code.exe' : 'code';
    const candidates = fs.existsSync(cache) ? fs.readdirSync(cache)
        .map(name => path.join(cache, name, executable))
        .filter(file => fs.existsSync(file))
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs) : [];
    if (!candidates[0]) {
        throw new Error('No cached VS Code executable found. Pass --vscode <executable>; this harness never downloads VS Code.');
    }
    return candidates[0];
}

async function main() {
    if (!process.argv.includes('--run')) {
        console.log('Opt-in real extension-host tests (no hardware):\n'
            + '  node test\\managed-build\\run.js --run [--solution-extension <folder>] [--vscode <executable>]\n'
            + '    [--cda-bridge <module>] [--queued-duplicates]\n'
            + 'Uses a new workspace, profile, extensions directory and scratch area below .vscode-test\\managed-build.');
        return;
    }
    const installedExtensions = argument('--installed-extensions') || path.join(os.homedir(), '.vscode', 'extensions');
    const solutionExtension = argument('--solution-extension') || findSolutionExtension(installedExtensions);
    const manifest = JSON.parse(fs.readFileSync(path.join(solutionExtension, 'package.json'), 'utf8'));
    if (`${manifest.publisher}.${manifest.name}`.toLowerCase() !== 'arm.cmsis-csolution') {
        throw new Error('--solution-extension must point to an installed Arm.cmsis-csolution extension.');
    }
    const vscodeExecutablePath = argument('--vscode') || findCode();
    const bridge = argument('--cda-bridge');
    if (bridge && !fs.statSync(bridge).isFile()) {
        throw new Error('--cda-bridge must point to an existing CommonJS module.');
    }
    const runDirectory = path.join(repository, '.vscode-test', 'managed-build', `run-${randomUUID()}`);
    const workspace = path.join(runDirectory, 'workspace');
    const profile = path.join(runDirectory, 'user-data');
    const extensions = path.join(runDirectory, 'extensions');
    const scratch = path.join(runDirectory, 'scratch');
    for (const directory of [workspace, path.join(profile, 'User'), extensions, scratch]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    fs.cpSync(path.join(__dirname, 'fixture'), workspace, { recursive: true });
    const settings = {
        'cmsis-csolution.downloadPacks': false,
        'cmsis-csolution.useWebServices': false,
        'cmsis-csolution.autoRefreshOnFileChange': false,
        'environment-manager.activateOnWorkspaceOpen': false,
        'environment-manager.reactivateOnConfigChange': false,
        'environment-manager.activateOnConfigCreation': false,
        'cmsis-developer-assistant.agentRules.install': 'never',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'update.mode': 'none',
        'telemetry.telemetryLevel': 'off',
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
    };
    fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
    // Only the optional Arm Tools dependency is visible; no user's other extensions run.
    const environmentManager = fs.readdirSync(installedExtensions)
        .filter(name => /^arm\.environment-manager-/i.test(name))
        .sort().reverse()[0];
    if (environmentManager) {
        fs.symlinkSync(path.join(installedExtensions, environmentManager), path.join(extensions, environmentManager),
            process.platform === 'win32' ? 'junction' : 'dir');
    }
    const configuration = {
        runDirectory, workspace, repository, solutionExtension,
        solutionVersion: manifest.version, bridge,
        queuedDuplicates: process.argv.includes('--queued-duplicates'),
    };
    fs.writeFileSync(path.join(runDirectory, 'configuration.json'), JSON.stringify(configuration, null, 2));
    console.log(`Managed-build run: ${runDirectory}`);
    console.log(`Installed CMSIS Solution: ${solutionExtension} (${manifest.version})`);
    const hostOutput = fs.createWriteStream(path.join(runDirectory, 'host-output.log'));
    let pendingOutput = '';
    const output = new Writable({
        write(chunk, encoding, callback) {
            pendingOutput += chunk.toString();
            const lines = pendingOutput.split(/\r?\n/);
            pendingOutput = lines.pop() || '';
            for (const line of lines) {
                if (/\b(?:PASS|FAIL) (?:installed|real|no-op|compiler|already|queued|CDA|solution)|Exit code:/.test(line)) {
                    console.log(line);
                }
            }
            hostOutput.write(chunk, encoding, callback);
        },
    });
    try {
        await runTests({
            stdout: output, stderr: output,
            vscodeExecutablePath,
            extensionDevelopmentPath: solutionExtension,
            extensionTestsPath: path.join(__dirname, 'extension-host.js'),
            extensionTestsEnv: {
                CMSIS_MANAGED_BUILD_CONFIGURATION: path.join(runDirectory, 'configuration.json'),
                TMP: scratch, TEMP: scratch, TMPDIR: scratch,
            },
            launchArgs: [
                workspace, '--new-window', `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`,
                '--disable-telemetry', '--disable-updates', '--skip-welcome', '--skip-release-notes',
                ...(process.platform === 'linux' ? ['--disable-gpu'] : []),
            ],
        });
    } finally {
        await new Promise(resolve => hostOutput.end(resolve));
        console.log(`Results: ${path.join(runDirectory, 'results.json')}`);
        console.log(`Extension-host output: ${path.join(runDirectory, 'host-output.log')}`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
