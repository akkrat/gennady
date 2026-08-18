// @file: StackPlugin implementation for iOS/Swift repositories — wires detect, scope and plan.
// @consumers: stack-registry
// @tasks: SPIKE-ios-stack

import path from 'node:path';
import type { StackDetection, StackPlugin } from '../../stack.types.ts';
import { detectIosProject, type IosProject } from './ios-detect.logic.ts';
import { planIosGates } from './ios-plan.logic.ts';

/**
 * @purpose Build the `key: value` summary lines shown by `verify --plan` for an iOS project.
 * @param project Detected project.
 * @returns Human-readable summary lines.
 */
function summarize(project: IosProject): string[] {
  const container = project.container;
  const containerLine =
    container.kind === 'spm'
      ? 'Package.swift (SwiftPM)'
      : `${path.basename(container.path)} (${container.kind})${project.hybrid ? ' + Package.swift' : ''}`;

  return [
    `container: ${containerLine}`,
    `schemes:   ${project.schemes.length > 0 ? project.schemes.join(', ') : '(no shared schemes)'}`,
    `lint-cfg:  ${project.swiftlintConfig ?? '(none found — swiftlint would use its defaults)'}`,
  ];
}

/**
 * @purpose StackPlugin for iOS/Swift repositories. Detection: `Package.swift`, `*.xcodeproj`
 *   or `*.xcworkspace` at the root — a glob, not a fixed marker name (spec §3).
 * @implements {StackPlugin} in specs/stack/stack.spec.md
 * @invariant detect() runs no processes — pure filesystem probing.
 * @invariant Gates are container-level; positional targets do not narrow them (like node, D-STACK-006).
 * @consumer stack-registry
 */
export const iosPlugin: StackPlugin = {
  id: 'ios',
  marker: 'Project.swift / Package.swift / *.xcodeproj / *.xcworkspace',
  description: 'swift/tuist/xcodebuild build+test, swiftlint, swiftformat --lint',

  detect(root: string): StackDetection | null {
    const project = detectIosProject(root);
    if (project === null) {
      return null;
    }

    return {
      stack: 'ios',
      root,
      summary: summarize(project),
      diagnostics: project.diagnostics,
      details: project,
    };
  },

  verify: {
    resolveScope(detection, request) {
      const project = detection.details as IosProject;
      // xcodebuild/swift build operate on the whole container; explicit targets and
      // changed-file narrowing cannot subset a scheme (same trade-off as node, D-STACK-006).
      return {
        mode: request.mode,
        note: `ios gates run container-wide (${project.container.kind}); targets do not narrow them`,
        details: project,
      };
    },

    planGates(detection, _scope, _options) {
      return planIosGates(detection.details as IosProject);
    },
  },
};
