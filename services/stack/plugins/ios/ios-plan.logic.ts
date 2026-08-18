// @file: Turn a detected iOS project into an ordered, non-mutating gate plan.
// @consumers: ios-plugin, stack-registry (gate id list)
// @tasks: SPIKE-ios-stack

import path from 'node:path';
import type { EnvFailPredicate, Gate } from '../../stack.types.ts';
import { outputMatches } from '../../gate-runner.ts';
import type { IosProject } from './ios-detect.logic.ts';

/** Identifier of a built-in ios gate. */
export type IosGateId = 'build' | 'test' | 'lint' | 'format';

/** Built-in ios gates in run order — cheapest and most diagnostic first. */
export const IOS_GATE_ORDER: readonly IosGateId[] = ['build', 'test', 'lint', 'format'];

/** Human labels for each gate id. */
const GATE_LABELS: Readonly<Record<IosGateId, string>> = {
  build: 'swift/xcodebuild build',
  test: 'swift/xcodebuild test',
  lint: 'swiftlint (check only)',
  format: 'swiftformat --lint (check only)',
};

/**
 * Default per-gate timeouts in ms. Unlike golang (`go test -timeout`), neither
 * xcodebuild nor `swift test` accepts a wall-clock timeout flag — the runner's
 * timeoutMs is the only bound, so these are deliberately generous.
 */
const GATE_TIMEOUTS_MS: Readonly<Record<IosGateId, number>> = {
  build: 15 * 60_000,
  test: 20 * 60_000,
  lint: 5 * 60_000,
  format: 2 * 60_000,
};

/**
 * Default simulator destination for `xcodebuild test`. A concrete device name is
 * environment-specific; a wrong one is classified ENV_FAIL (never a code finding)
 * and repos pin their own via stack.ios.overrideGates.test.
 */
export const DEFAULT_TEST_DESTINATION = 'platform=iOS Simulator,name=iPhone 16';

/** Environment breakage in Xcode tooling — the code was never exercised. */
const XCODE_ENV_FAIL: readonly EnvFailPredicate[] = [
  outputMatches(/Unable to find a destination matching/),
  outputMatches(/requires a development team|No profiles for /),
  outputMatches(/xcrun: error:|xcode-select: error:/),
  outputMatches(/Unable to boot|Failed to prepare device/),
  outputMatches(/license agreements|by running `?sudo xcodebuild -license/i),
];

/** Tuist environment breakage on top of Xcode's — missing deps/auth are not code findings. */
const TUIST_ENV_FAIL: readonly EnvFailPredicate[] = [
  ...XCODE_ENV_FAIL,
  outputMatches(/tuist install|dependencies.*not.*(installed|fetched)/i),
  // Observed live on a server-backed tuist setup: it demands `tuist auth login` before building.
  outputMatches(/Token for Tuist was not found|tuist auth login/i),
];

/**
 * @purpose Create a gate that is reported but never executed, with the reason recorded.
 * @param id Gate identifier.
 * @param cwd Working directory the gate would have used.
 * @param reason Why the gate cannot run.
 * @returns A skipped gate carrying the reason.
 */
function skippedGate(id: IosGateId, cwd: string, reason: string): Gate {
  return {
    id,
    stack: 'ios',
    label: GATE_LABELS[id],
    argv: [],
    cwd,
    timeoutMs: GATE_TIMEOUTS_MS[id],
    outputMeansFailure: false,
    skipped: reason,
  };
}

/**
 * @purpose Compose the container flag pair for xcodebuild.
 * @param project Detected project; must carry an Xcode container.
 * @returns `-project <path>` or `-workspace <path>`.
 */
function containerFlags(project: IosProject): string[] {
  const container = project.container;
  if (container.kind === 'workspace') {
    return ['-workspace', container.path];
  }
  if (container.kind === 'project') {
    return ['-project', container.path];
  }
  return [];
}

/**
 * @purpose Why xcodebuild gates cannot run, or null when they can.
 * @param project Detected project.
 * @param platform Host platform; injectable for tests.
 * @returns Skip reason, or null.
 */
function xcodeSkipReason(project: IosProject, platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') {
    return 'xcodebuild requires macOS (IOS_REQUIRES_MACOS)';
  }
  if (project.tools.xcodebuild.bin === null) {
    return 'xcodebuild not found in PATH (IOS_XCODEBUILD_MISSING)';
  }
  if (project.container.kind === 'tuist') {
    // tuist needs no scheme: build/test default to every buildable/testable target.
    return project.tools.tuist.bin === null
      ? 'tuist not found in PATH (IOS_TUIST_MISSING) — install it, or skip via stack.ios.skipGates'
      : null;
  }
  if (project.schemes.length === 0) {
    return 'no shared scheme (IOS_NO_SHARED_SCHEME) — share one or override argv via stack.ios.overrideGates';
  }
  return null;
}

/**
 * @purpose Plan the ios gate list for a project.
 * @invariant Gates never mutate sources: check-only lint/format, signing disabled;
 *   tuist generation writes only gitignored artifacts (build-output-equivalent).
 * @invariant Emitted gates follow IOS_GATE_ORDER; unrunnable gates carry a skip reason.
 * @param project Detected iOS project.
 * @param [platform] Host platform; defaults to the current process, injectable for tests.
 * @returns Ordered gate plan.
 */
export function planIosGates(
  project: IosProject,
  platform: NodeJS.Platform = process.platform
): Gate[] {
  const swift = project.tools.swift.bin;
  const xcodebuild = project.tools.xcodebuild.bin;
  const swiftlint = project.tools.swiftlint.bin;
  const swiftformat = project.tools.swiftformat.bin;

  const spm = project.container.kind === 'spm';
  const tuist = project.container.kind === 'tuist';
  const scheme = project.schemes[0];
  const xcodeSkip = spm ? null : xcodeSkipReason(project, platform);
  const tuistBin = project.tools.tuist.bin;
  const gates: Gate[] = [];

  // #region START_GATE_ASSEMBLY — invariant: emitted gates follow IOS_GATE_ORDER
  for (const id of IOS_GATE_ORDER) {
    switch (id) {
      case 'build':
        if (spm) {
          gates.push(
            swift === null
              ? skippedGate(
                  id,
                  project.root,
                  'swift toolchain not found in PATH (IOS_SWIFT_MISSING)'
                )
              : {
                  id,
                  stack: 'ios',
                  label: 'swift build',
                  argv: [swift, 'build'],
                  cwd: project.root,
                  timeoutMs: GATE_TIMEOUTS_MS[id],
                  outputMeansFailure: false,
                  envFail: XCODE_ENV_FAIL,
                  skipped: null,
                }
          );
        } else if (tuist) {
          gates.push(
            xcodeSkip !== null
              ? skippedGate(id, project.root, xcodeSkip)
              : {
                  id,
                  stack: 'ios',
                  label: 'tuist build',
                  argv: [tuistBin!, 'build'],
                  cwd: project.root,
                  timeoutMs: GATE_TIMEOUTS_MS[id],
                  outputMeansFailure: false,
                  envFail: TUIST_ENV_FAIL,
                  skipped: null,
                }
          );
        } else {
          gates.push(
            xcodeSkip !== null
              ? skippedGate(id, project.root, xcodeSkip)
              : {
                  id,
                  stack: 'ios',
                  label: `xcodebuild build (${scheme!})`,
                  // CODE_SIGNING_ALLOWED=NO: verification must not require certificates.
                  argv: [
                    xcodebuild!,
                    'build',
                    ...containerFlags(project),
                    '-scheme',
                    scheme!,
                    '-destination',
                    'generic/platform=iOS Simulator',
                    'CODE_SIGNING_ALLOWED=NO',
                  ],
                  cwd: project.root,
                  timeoutMs: GATE_TIMEOUTS_MS[id],
                  outputMeansFailure: false,
                  envFail: XCODE_ENV_FAIL,
                  skipped: null,
                }
          );
        }
        break;

      case 'test':
        if (spm) {
          gates.push(
            swift === null
              ? skippedGate(
                  id,
                  project.root,
                  'swift toolchain not found in PATH (IOS_SWIFT_MISSING)'
                )
              : {
                  id,
                  stack: 'ios',
                  label: 'swift test',
                  argv: [swift, 'test'],
                  cwd: project.root,
                  timeoutMs: GATE_TIMEOUTS_MS[id],
                  outputMeansFailure: false,
                  envFail: XCODE_ENV_FAIL,
                  skipped: null,
                }
          );
        } else if (tuist) {
          gates.push(
            xcodeSkip !== null
              ? skippedGate(id, project.root, xcodeSkip)
              : {
                  id,
                  stack: 'ios',
                  label: 'tuist test',
                  argv: [tuistBin!, 'test'],
                  cwd: project.root,
                  timeoutMs: GATE_TIMEOUTS_MS[id],
                  outputMeansFailure: false,
                  envFail: TUIST_ENV_FAIL,
                  skipped: null,
                }
          );
        } else {
          gates.push(
            xcodeSkip !== null
              ? skippedGate(id, project.root, xcodeSkip)
              : {
                  id,
                  stack: 'ios',
                  label: `xcodebuild test (${scheme!}, ${DEFAULT_TEST_DESTINATION})`,
                  argv: [
                    xcodebuild!,
                    'test',
                    ...containerFlags(project),
                    '-scheme',
                    scheme!,
                    '-destination',
                    DEFAULT_TEST_DESTINATION,
                    'CODE_SIGNING_ALLOWED=NO',
                  ],
                  cwd: project.root,
                  timeoutMs: GATE_TIMEOUTS_MS[id],
                  outputMeansFailure: false,
                  envFail: XCODE_ENV_FAIL,
                  skipped: null,
                }
          );
        }
        break;

      case 'lint':
        if (swiftlint === null) {
          gates.push(
            skippedGate(
              id,
              project.root,
              'swiftlint not found (PATH or ./bin) — install it, or skip via stack.ios.skipGates'
            )
          );
        } else {
          gates.push({
            id,
            stack: 'ios',
            // `swiftlint lint` is check-only; the rewriting `swiftlint --fix` is forbidden as a gate.
            label: `swiftlint${project.swiftlintConfig === null ? ' (default config)' : ''}`,
            argv: [
              swiftlint,
              'lint',
              '--strict',
              ...(project.swiftlintConfig !== null ? ['--config', project.swiftlintConfig] : []),
            ],
            cwd: project.root,
            timeoutMs: GATE_TIMEOUTS_MS[id],
            outputMeansFailure: false,
            envFail: [outputMatches(/^Fatal error:/m), ...XCODE_ENV_FAIL],
            skipped: null,
          });
        }
        break;

      case 'format':
        if (swiftformat === null) {
          gates.push(skippedGate(id, project.root, 'swiftformat not found in PATH'));
        } else if (project.swiftformatConfig === null) {
          gates.push(
            skippedGate(
              id,
              project.root,
              'no .swiftformat config — default rules are opinionated; add a config or an extraGate'
            )
          );
        } else {
          gates.push({
            id,
            stack: 'ios',
            // `--lint` only reports; the default rewriting mode is forbidden as a gate.
            label: 'swiftformat --lint',
            argv: [
              swiftformat,
              '--lint',
              path.dirname(project.swiftformatConfig),
              '--config',
              project.swiftformatConfig,
            ],
            cwd: project.root,
            timeoutMs: GATE_TIMEOUTS_MS[id],
            outputMeansFailure: false,
            envFail: [outputMatches(/^Fatal error:/m)],
            skipped: null,
          });
        }
        break;
    }
  }
  // #endregion END_GATE_ASSEMBLY

  return gates;
}
