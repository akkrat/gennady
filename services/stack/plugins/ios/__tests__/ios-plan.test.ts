// @file: Unit tests for the ios gate planner — non-mutating gates, skip reasons, env-fail predicates.
// @consumers: CI
// @tasks: SPIKE-ios-stack

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IosProject, IosTool, IosToolId } from '../ios-detect.logic.ts';

const { planIosGates, IOS_GATE_ORDER, DEFAULT_TEST_DESTINATION } =
  await import('../ios-plan.logic.ts');

/** @purpose Build a resolved tool stub pointing at a fake absolute path. */
function tool(id: IosToolId, available = true): IosTool {
  return { id, bin: available ? `/usr/bin/${id}` : null, origin: available ? 'path' : 'missing' };
}

/** @purpose Build a SwiftPM project fixture, overriding only the fields a test cares about. */
function spmProject(overrides: Partial<IosProject> = {}): IosProject {
  return {
    root: '/repo',
    container: { kind: 'spm', manifest: '/repo/Package.swift' },
    hybrid: false,
    schemes: [],
    tools: {
      swift: tool('swift'),
      xcodebuild: tool('xcodebuild'),
      swiftlint: tool('swiftlint'),
      swiftformat: tool('swiftformat'),
    },
    swiftlintConfig: '/repo/.swiftlint.yml',
    swiftformatConfig: '/repo/.swiftformat',
    diagnostics: [],
    ...overrides,
  };
}

/** @purpose Build an Xcode-project fixture with one shared scheme. */
function xcodeProject(overrides: Partial<IosProject> = {}): IosProject {
  return spmProject({
    container: { kind: 'project', path: '/repo/CoolApp.xcodeproj' },
    schemes: ['CoolApp'],
    ...overrides,
  });
}

describe('planIosGates', () => {
  it('plans exactly the built-in gates in order: build, test, lint, format', () => {
    const ids = planIosGates(spmProject(), 'darwin').map((gate) => gate.id);

    assert.deepEqual(ids, [...IOS_GATE_ORDER]);
  });

  it('never plans a mutating command: no --fix, no bare swiftformat rewrite', () => {
    for (const project of [spmProject(), xcodeProject()]) {
      for (const gate of planIosGates(project, 'darwin')) {
        const argv = gate.argv.join(' ');
        assert.ok(!argv.includes('--fix'), `${gate.id} must not rewrite the tree`);
        if (gate.argv[0]?.endsWith('swiftformat')) {
          assert.ok(argv.includes('--lint'), 'swiftformat must run in --lint mode');
        }
      }
    }
  });

  it('gives every gate a mandatory positive timeout', () => {
    for (const gate of planIosGates(xcodeProject(), 'darwin')) {
      assert.ok(gate.timeoutMs > 0, `${gate.id} must carry a timeout`);
    }
  });

  it('uses swift build/test for SwiftPM containers', () => {
    const gates = planIosGates(spmProject(), 'darwin');

    assert.deepEqual(gates.find((g) => g.id === 'build')?.argv, ['/usr/bin/swift', 'build']);
    assert.deepEqual(gates.find((g) => g.id === 'test')?.argv, ['/usr/bin/swift', 'test']);
  });

  it('uses xcodebuild with the shared scheme and disables code signing', () => {
    const build = planIosGates(xcodeProject(), 'darwin').find((g) => g.id === 'build');

    assert.equal(build?.skipped, null);
    assert.ok(build?.argv.includes('-project'));
    assert.ok(build?.argv.includes('CoolApp'));
    assert.ok(build?.argv.includes('CODE_SIGNING_ALLOWED=NO'));
  });

  it('plans xcodebuild test against the default simulator destination with env-fail cover', () => {
    const test = planIosGates(xcodeProject(), 'darwin').find((g) => g.id === 'test');

    assert.ok(test?.argv.includes(DEFAULT_TEST_DESTINATION));
    const missingSimulator = 'xcodebuild: error: Unable to find a destination matching iPhone 16';
    assert.ok(
      test?.envFail?.some((predicate) => predicate(70, missingSimulator)),
      'a wrong simulator must classify as ENV_FAIL, not as a code finding'
    );
  });

  it('skips xcodebuild gates without a shared scheme, with the reason recorded', () => {
    const gates = planIosGates(xcodeProject({ schemes: [] }), 'darwin');

    for (const id of ['build', 'test'] as const) {
      const gate = gates.find((g) => g.id === id);
      assert.ok(gate?.skipped?.includes('IOS_NO_SHARED_SCHEME'), `${id} must be skipped`);
    }
  });

  it('skips xcodebuild gates on non-mac hosts but keeps lint/format runnable', () => {
    const gates = planIosGates(xcodeProject(), 'linux');

    assert.ok(gates.find((g) => g.id === 'build')?.skipped?.includes('macOS'));
    assert.equal(gates.find((g) => g.id === 'lint')?.skipped, null);
  });

  it('skips the format gate when no .swiftformat config exists', () => {
    const gates = planIosGates(spmProject({ swiftformatConfig: null }), 'darwin');

    assert.ok(gates.find((g) => g.id === 'format')?.skipped?.includes('.swiftformat'));
  });

  it('passes the repo lint config explicitly and marks default-config runs in the label', () => {
    const withConfig = planIosGates(spmProject(), 'darwin').find((g) => g.id === 'lint');
    const withoutConfig = planIosGates(spmProject({ swiftlintConfig: null }), 'darwin').find(
      (g) => g.id === 'lint'
    );

    assert.ok(withConfig?.argv.includes('--config'));
    assert.ok(withoutConfig?.label.includes('default config'));
  });
});
