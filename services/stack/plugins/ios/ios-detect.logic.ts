// @file: Detect an iOS/Swift project — SwiftPM manifest or Xcode container, tools, shared schemes.
// @consumers: ios-plugin, ios-plan.logic
// @tasks: SPIKE-ios-stack

import fs from 'node:fs';
import path from 'node:path';
import type { StackDiagnostic } from '../../stack.types.ts';

/** Identifier of a tool the ios gates rely on. */
export type IosToolId = 'swift' | 'xcodebuild' | 'tuist' | 'swiftlint' | 'swiftformat';

/**
 * @purpose A resolved (or missing) executable the plan needs.
 * @consumer ios-plan.logic
 */
export type IosTool = {
  /** @purpose Tool identifier, also the binary name. */
  readonly id: IosToolId;
  /** @purpose Absolute path to the executable, or null when unavailable. */
  readonly bin: string | null;
  /** @purpose Where the binary came from. */
  readonly origin: 'repo-bin' | 'path' | 'missing';
};

/**
 * @purpose The buildable container kind. Precedence: tuist > workspace > project >
 *   Package.swift — Tuist manifests are authoritative; generated containers may be stale.
 * @consumer ios-plan.logic
 */
export type IosContainer =
  | { readonly kind: 'spm'; readonly manifest: string }
  | { readonly kind: 'tuist'; readonly manifest: string }
  | { readonly kind: 'project'; readonly path: string }
  | { readonly kind: 'workspace'; readonly path: string };

/**
 * @purpose Detection payload of the ios plugin — facts gathered once so planning
 *   never re-reads the disk (spec §4.1).
 * @consumer ios-plugin, ios-plan.logic
 */
export type IosProject = {
  /** @purpose Absolute repository root. */
  readonly root: string;
  /** @purpose Buildable container chosen for the gates. */
  readonly container: IosContainer;
  /** @purpose True when both Package.swift and an Xcode container exist. */
  readonly hybrid: boolean;
  /** @purpose Shared scheme names, sorted; xcodebuild gates need one to be deterministic. */
  readonly schemes: readonly string[];
  /** @purpose Resolved tools keyed by id. */
  readonly tools: Readonly<Record<IosToolId, IosTool>>;
  /** @purpose Absolute path to `.swiftlint.yml`, or null. */
  readonly swiftlintConfig: string | null;
  /** @purpose Absolute path to `.swiftformat`, or null. */
  readonly swiftformatConfig: string | null;
  /** @purpose Environment problems surfaced at detect time. */
  readonly diagnostics: readonly StackDiagnostic[];
};

/**
 * @purpose Resolve an executable, preferring a repo-pinned `bin/<id>` over PATH.
 *   Duplicates golang-detect's resolveTool — extraction into shared infra is overdue.
 * @param id Tool identifier used for both the binary name and the report.
 * @param root Absolute repository root, searched for a pinned `bin/<id>`.
 * @returns Resolved tool; `bin` is null when the tool is unavailable.
 */
function resolveTool(id: IosToolId, root: string): IosTool {
  const pinned = path.join(root, 'bin', id);
  try {
    fs.accessSync(pinned, fs.constants.X_OK);
    return { id, bin: pinned, origin: 'repo-bin' };
  } catch {
    // Fall through to PATH lookup.
  }

  const pathEntries = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, id);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { id, bin: candidate, origin: 'path' };
    } catch {
      continue;
    }
  }

  return { id, bin: null, origin: 'missing' };
}

/**
 * @purpose List shared scheme names of an Xcode container. Only shared schemes are
 *   deterministic: user schemes live under xcuserdata and differ per machine.
 * @param containerPath Absolute path to the .xcodeproj or .xcworkspace directory.
 * @returns Sorted scheme names, empty when none are shared.
 */
function findSharedSchemes(containerPath: string): string[] {
  const schemesDir = path.join(containerPath, 'xcshareddata', 'xcschemes');
  let entries: string[];
  try {
    entries = fs.readdirSync(schemesDir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.endsWith('.xcscheme'))
    .map((entry) => entry.slice(0, -'.xcscheme'.length))
    .sort();
}

/**
 * @purpose Pick the container: tuist > workspace > project > Package.swift. Xcode containers
 *   are `<AppName>.xcodeproj` globs, not fixed-name markers.
 * @param root Absolute repository root.
 * @param rootEntries Entries of the root directory.
 * @returns Chosen container, or null when the repository is not an ios/Swift project.
 */
function chooseContainer(root: string, rootEntries: readonly string[]): IosContainer | null {
  // Tuist repos gitignore their generated .xcodeproj/.xcworkspace — the manifest is authoritative.
  const tuistManifest = ['Workspace.swift', 'Project.swift'].find((name) =>
    rootEntries.includes(name)
  );
  if (tuistManifest !== undefined) {
    return { kind: 'tuist', manifest: path.join(root, tuistManifest) };
  }

  const workspace = rootEntries.filter((entry) => entry.endsWith('.xcworkspace')).sort()[0];
  if (workspace !== undefined) {
    return { kind: 'workspace', path: path.join(root, workspace) };
  }

  const project = rootEntries.filter((entry) => entry.endsWith('.xcodeproj')).sort()[0];
  if (project !== undefined) {
    return { kind: 'project', path: path.join(root, project) };
  }

  if (rootEntries.includes('Package.swift')) {
    return { kind: 'spm', manifest: path.join(root, 'Package.swift') };
  }

  return null;
}

/**
 * @purpose Gather every fact the ios gates need from a repository root.
 * @invariant Runs no processes — detection is pure filesystem probing.
 * @param root Absolute repository root.
 * @param [platform] Host platform; defaults to the current process, injectable for tests.
 * @returns Project facts, or null when no SwiftPM manifest or Xcode container exists at the root.
 */
export function detectIosProject(
  root: string,
  platform: NodeJS.Platform = process.platform
): IosProject | null {
  let rootEntries: string[];
  try {
    rootEntries = fs.readdirSync(root);
  } catch {
    return null;
  }

  const container = chooseContainer(root, rootEntries);
  if (container === null) {
    return null;
  }

  const hybrid = container.kind !== 'spm' && rootEntries.includes('Package.swift');
  const schemes =
    container.kind === 'project' || container.kind === 'workspace'
      ? findSharedSchemes(container.path)
      : [];
  const tools: Record<IosToolId, IosTool> = {
    swift: resolveTool('swift', root),
    xcodebuild: resolveTool('xcodebuild', root),
    tuist: resolveTool('tuist', root),
    swiftlint: resolveTool('swiftlint', root),
    swiftformat: resolveTool('swiftformat', root),
  };

  const swiftlintConfig = rootEntries.includes('.swiftlint.yml')
    ? path.join(root, '.swiftlint.yml')
    : null;
  const swiftformatConfig = rootEntries.includes('.swiftformat')
    ? path.join(root, '.swiftformat')
    : null;

  const diagnostics: StackDiagnostic[] = [];

  // #region START_ENV_DIAGNOSTICS — surfaced before any gate runs, never silent
  if (container.kind !== 'spm' && platform !== 'darwin') {
    diagnostics.push({
      code: 'IOS_REQUIRES_MACOS',
      message:
        'An Xcode container was detected but this host is not macOS — xcodebuild cannot run.',
      fix: 'Run gennady verify on a macOS host, or skip ios gates via stack.ios.skipGates.',
    });
  } else if (container.kind !== 'spm' && tools.xcodebuild.bin === null) {
    diagnostics.push({
      code: 'IOS_XCODEBUILD_MISSING',
      message: 'An Xcode container was detected but xcodebuild is not in PATH.',
      fix: 'Install Xcode and run `xcode-select --switch /Applications/Xcode.app`.',
    });
  }

  if ((container.kind === 'project' || container.kind === 'workspace') && schemes.length === 0) {
    diagnostics.push({
      code: 'IOS_NO_SHARED_SCHEME',
      message: `${path.basename(container.path)} has no shared scheme — xcodebuild gates cannot be planned deterministically.`,
      fix: 'Share a scheme in Xcode (Manage Schemes → Shared), or override argv via stack.ios.overrideGates.',
    });
  }

  // tuist build/test need no scheme — they default to every buildable/testable target.
  if (container.kind === 'tuist' && tools.tuist.bin === null) {
    diagnostics.push({
      code: 'IOS_TUIST_MISSING',
      message: `${path.basename(container.manifest)} was detected but tuist is not in PATH.`,
      fix: 'Install tuist (`brew install tuist` or `mise install tuist`), or skip via stack.ios.skipGates.',
    });
  }

  if (container.kind === 'spm' && tools.swift.bin === null) {
    diagnostics.push({
      code: 'IOS_SWIFT_MISSING',
      message: 'Package.swift was detected but the swift toolchain is not in PATH.',
      fix: 'Install Xcode (macOS) or a Swift toolchain (https://swift.org/install).',
    });
  }
  // #endregion END_ENV_DIAGNOSTICS

  return {
    root,
    container,
    hybrid,
    schemes,
    tools,
    swiftlintConfig,
    swiftformatConfig,
    diagnostics,
  };
}
