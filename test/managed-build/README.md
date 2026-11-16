# Managed-build extension-host integration

Opt-in, hardware-free tests of the **installed CMSIS Solution extension** with
[managed build API V3 (PR #713)](https://github.com/Open-CMSIS-Pack/vscode-cmsis-solution/pull/713).
They run in a real VS Code extension host through the existing
`@vscode/test-electron` dependency, not the transport harness's VS Code stub.
Nothing is added to the normal unit-test run or package scripts.

## Run

From the repository root, on Windows:

```powershell
node test\managed-build\run.js --run
```

Without `--run`, the launcher only prints usage. It discovers an existing cached
VS Code executable under `.vscode-test` and an installed CMSIS Solution bundle
with managed output support. Discovery prefers the most recently modified matching
bundle, **not the highest extension version**: locally updated `1.72.0` can contain
the new API while a newer-numbered release does not. Override either explicitly:

```powershell
node test\managed-build\run.js --run `
  --vscode D:\tools\VSCode\Code.exe `
  --solution-extension C:\Users\you\.vscode\extensions\arm.cmsis-csolution-1.72.0
```

Prerequisites: the installed extension contains PR #713, local `ARM::CMSIS` and
`ARM::Cortex_DFP` packs, and a registered GCC toolchain (for example an inherited
`GCC_TOOLCHAIN_14_2_1` environment variable). No compiler licence is needed for GCC.
The launcher neither installs dependencies nor downloads VS Code, extensions,
packs or toolchains. Missing prerequisites fail with evidence, not a mock fallback.
Use `--installed-extensions <folder>` if installations live elsewhere.

## Isolation and evidence

Each run gets a UUID directory below `.vscode-test\managed-build` containing:

- A copied, tiny ARMCM3 static-library workspace. Its source is the **only** file
  deliberately changed to provoke compilation failure; it is restored afterward.
- A fresh user-data directory, disabled workspace trust and telemetry, and disabled
  automatic extension updates, pack downloads, web services and file conversion.
- An isolated extensions directory exposing only the optional installed Arm Tools
  extension through a directory link. The chosen installed CMSIS Solution is loaded
  directly as the development extension, so another installed version cannot win.
- A private scratch area, also supplied as `TMP`, `TEMP` and `TMPDIR` to VS Code,
  holding the original API-managed build logs.
- `results.json` with case results, actual exit codes, task/operation IDs and original
  log paths; `host-output.log` retains full extension-host stdout/stderr. These are
  ignored run evidence, not committed fixtures.

There is no hardware, flash, debugger launch, external MCP connection, existing
workspace activation, global settings update or shell invocation of CMSIS tools.
All real builds are submitted through `getApi(3).build()` **inside** the test host.
Installed tools and packs are reused, not modified by the harness. Run folders
are retained for inspection and can be removed after the VS Code test exits.

Coverage exercises real successful compilation, a genuine no-op with an
unchanged library timestamp, intentional compiler failure with its nonzero exit
code, already-aborted cancellation without a task, stable/late result promises,
unchanged solution/target selection, and byte-for-byte equality between complete
live output and the original saved UTF-8 log. Build, rebuild and clean use the
same managed API flags; case names and recorded results, rather than a fixed
case count, describe each run's coverage. Normal submitted builds start exactly
one managed task; no diagnostic rerun is introduced.

### Queued duplicates: separate opt-in probe

```powershell
node test\managed-build\run.js --run --queued-duplicates
```

This submits five identical rebuild requests and expects at least one independently
settled `skipped` result with an empty log and no exit code. This is separate from
required coverage because VS Code's concurrent task identity/event handling can
prevent the API's toolbox queue from receiving every request. The test does not
turn that failure into a pass. Concurrent task-start events can share identity,
so this probe records them but does not require one start event per operation.
Pre-aborted cancellation remains in the required run regardless.

## CDA adapter integration contract

Raw API tests intentionally report CDA integration as **not run**, not as passing.
The checked-in `cda-bridge.js` exercises CDA's actual compiled
`runCmsisAction` and `BuildInfoHandler` with the real VS Code host and installed
V3 API. From the repository root, run the full integration with:

```powershell
npm run compile
node test\managed-build\run.js --run `
  --solution-extension C:\Users\you\.vscode\extensions\arm.cmsis-csolution-1.72.0 `
  --cda-bridge .\test\managed-build\cda-bridge.js
```

Replace the installed extension path with the updated V3-capable bundle on your
machine; omit `--solution-extension` to use discovery. `--vscode` can still
select a cached executable. No board is involved.

A custom bridge can use the same CommonJS contract:

```javascript
exports.createBridge = async ({ vscode, api, workspace, repository }) => ({
    // Invoke the actual compiled CDA handler/adapter. Return its agent-visible text.
    action: async ({ action, timeoutMs, operationId }) =>
        actualCdaAction(action, timeoutMs, operationId),
    diagnostics: async operationId => actualCdaDiagnostics(operationId),
    dispose: async () => { /* dispose only objects this bridge constructed */ },
});
```

`api` is the **real installed V3 API**, instrumented with a transparent proxy so
the tests can observe original operations and output without stubbing execution.
Inject this object into CDA's API getter/dependencies. `workspace` is the disposable
fixture root, and `repository` locates compiled CDA modules. Do not start CDA's MCP
server or activate a different workspace. The adapter can be imported directly;
there is no requirement to expose test-only commands or production exports.

CDA coverage requires exactly one observed real V3 operation per submitted build,
correct success/failure replies, the original log path, original live/log byte
identity, actual no-op output and diagnostics from the original failure log
without a replacement build. Short waits retain the operation: `status` and
`stop_build` pass its `operationId`, never submit another operation, and report
the settled status even if natural success/failure wins a cancellation race.
A bridge that substitutes canned results fails.

CDA treats the V3 result as authoritative, including `cancelled` and `skipped`:
a skipped duplicate is not success or a different operation's result. Unknown
or expired explicit IDs must not fall back to another task, build or log. The
registry retains pending operations and keeps up to 32 completed operations for
30 minutes, until a window reload. Unit coverage in
`src/test/managedBuilds.test.ts` checks these lifecycle and fallback contracts;
the real harness reports only the cases it actually exercises. The legacy
diagnostic rerun and image-timestamp heuristics are fallback behaviour for older
extensions without V3, not part of this managed integration path.

## Local verification, 16 November 2026

The latest retained full run with the checked-in `cda-bridge.js` passed
**12/12 cases** against the installed, locally updated
`arm.cmsis-csolution-1.72.0`, using cached VS Code 1.144.0 and GCC 14.2.1.
It exercised the isolated ARMCM3 library fixture, no-op, compiler exit code 1,
original logs, explicit and active-context CDA diagnostics, clean/rebuild,
pending/duplicate-join/status/cancellation and unchanged selection, with no board.
The production legacy diagnosis observer was attached, with an explicit assertion
that it spawned no diagnostic rerun. This is a historical run result, not a fixed
expected case count; each run records its cases in `results.json`.
The equivalent run command is in the integration section above.

The separate `node test\managed-build\run.js --run --queued-duplicates`
probe did **not** pass. It exposed unresolved upstream operation/task identity
problems: concurrent operations without corresponding task-start events,
an empty-log failed completion, mismatched operation IDs on shared executions,
and unresolved handles reaching the 120-second deadline on a subsequent run.
Passing sequential integration does not establish concurrent queue correctness;
no production workaround or mock fallback was added.

The installed bundle was updated locally on 16 November. This does not claim
that public release 1.72.0 contains the managed build API.
