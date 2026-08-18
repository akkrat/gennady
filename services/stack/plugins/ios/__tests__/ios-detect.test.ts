// @file: Unit tests for iOS project detection — containers, schemes, tool configs, diagnostics.
// @consumers: CI
// @tasks: SPIKE-ios-stack

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { detectIosProject } = await import('../ios-detect.logic.ts');

let root: string;

/** @purpose Write a file inside the fixture, creating parent directories as needed. */
function write(relativePath: string, content = ''): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-detect-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectIosProject', () => {
  it('returns null for a directory with no SwiftPM manifest or Xcode container', () => {
    write('main.go');

    assert.equal(detectIosProject(root, 'darwin'), null);
  });

  it('detects a pure SwiftPM package', () => {
    write('Package.swift', '// swift-tools-version:6.0\n');

    const project = detectIosProject(root, 'darwin');

    assert.equal(project?.container.kind, 'spm');
    assert.equal(project?.hybrid, false);
  });

  it('detects a *.xcodeproj container by glob, not by a fixed marker name', () => {
    write('CoolApp.xcodeproj/project.pbxproj');

    const project = detectIosProject(root, 'darwin');

    assert.equal(project?.container.kind, 'project');
    assert.ok(
      project?.container.kind === 'project' && project.container.path.endsWith('CoolApp.xcodeproj')
    );
  });

  it('prefers a workspace over a project, and an Xcode container over Package.swift', () => {
    write('CoolApp.xcodeproj/project.pbxproj');
    write('CoolApp.xcworkspace/contents.xcworkspacedata');
    write('Package.swift');

    const project = detectIosProject(root, 'darwin');

    assert.equal(project?.container.kind, 'workspace');
    assert.equal(project?.hybrid, true);
  });

  it('prefers Tuist manifests over generated Xcode containers — the manifest is authoritative', () => {
    write('Project.swift', 'import ProjectDescription\n');
    write('CoolApp.xcodeproj/project.pbxproj');
    write('CoolApp.xcworkspace/contents.xcworkspacedata');

    const project = detectIosProject(root, 'darwin');

    assert.equal(project?.container.kind, 'tuist');
  });

  it('detects a Tuist workspace manifest and requires no shared scheme', () => {
    write('Workspace.swift', 'import ProjectDescription\n');

    const project = detectIosProject(root, 'darwin');

    assert.equal(project?.container.kind, 'tuist');
    const codes = project?.diagnostics.map((d) => d.code);
    assert.ok(!codes?.includes('IOS_NO_SHARED_SCHEME'), 'tuist needs no shared scheme');
  });

  it('lists shared schemes sorted; user schemes in xcuserdata are ignored', () => {
    write('CoolApp.xcodeproj/xcshareddata/xcschemes/Zeta.xcscheme');
    write('CoolApp.xcodeproj/xcshareddata/xcschemes/Alpha.xcscheme');
    write('CoolApp.xcodeproj/xcuserdata/me.xcuserdatad/xcschemes/Private.xcscheme');

    const project = detectIosProject(root, 'darwin');

    assert.deepEqual(project?.schemes, ['Alpha', 'Zeta']);
  });

  it('surfaces IOS_NO_SHARED_SCHEME for a container without shared schemes', () => {
    write('CoolApp.xcodeproj/project.pbxproj');

    const codes = detectIosProject(root, 'darwin')?.diagnostics.map((d) => d.code);

    assert.ok(codes?.includes('IOS_NO_SHARED_SCHEME'));
  });

  it('surfaces IOS_REQUIRES_MACOS for an Xcode container on a non-mac host', () => {
    write('CoolApp.xcodeproj/project.pbxproj');

    const codes = detectIosProject(root, 'linux')?.diagnostics.map((d) => d.code);

    assert.ok(codes?.includes('IOS_REQUIRES_MACOS'));
  });

  it('does not require macOS for a pure SwiftPM package', () => {
    write('Package.swift');

    const codes = detectIosProject(root, 'linux')?.diagnostics.map((d) => d.code);

    assert.ok(!codes?.includes('IOS_REQUIRES_MACOS'));
  });

  it('finds swiftlint and swiftformat configs at the root', () => {
    write('Package.swift');
    write('.swiftlint.yml', 'strict: true\n');
    write('.swiftformat', '--indent 2\n');

    const project = detectIosProject(root, 'darwin');

    assert.equal(path.basename(project?.swiftlintConfig ?? ''), '.swiftlint.yml');
    assert.equal(path.basename(project?.swiftformatConfig ?? ''), '.swiftformat');
  });
});
