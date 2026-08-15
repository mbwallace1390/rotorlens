// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = relativePath => readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

const authoredSources = [
  'ios/RotorLens/AppDelegate.swift',
  'ios/RotorLens/ImportStore.swift',
  'ios/RotorLens/NativeBridge.swift',
  'ios/RotorLens/PrivateStore.swift',
  'ios/RotorLens/RotorLensDocumentTypes.swift',
  'ios/RotorLens/RotorLensOrigin.swift',
  'ios/RotorLens/SceneDelegate.swift',
  'ios/RotorLens/ViewerViewController.swift',
  'ios/RotorLens/WebAssetSchemeHandler.swift',
  'ios/RotorLensTests/ImportStoreTests.swift',
  'ios/RotorLensTests/PrivateStoreTests.swift',
  'ios/RotorLensTests/RotorLensDocumentTypesTests.swift',
  'ios/RotorLensTests/WebAssetSchemeHandlerTests.swift',
  'ios/scripts/generate-project.sh',
  'ios/tests/ios-static-contract.test.mjs'
];

test('the source-only iOS project is complete and carries project attribution', () => {
  const requiredFiles = [
    ...authoredSources,
    'ios/.xcodegen-version',
    'ios/.gitignore',
    'ios/project.yml',
    'ios/RotorLens/Info.plist',
    'ios/RotorLens/PrivacyInfo.xcprivacy',
    'docs/IOS_PORT.md',
    'LICENSE',
    'NOTICE'
  ];
  for (const relativePath of requiredFiles) {
    assert.equal(existsSync(path.join(repositoryRoot, relativePath)), true, relativePath);
  }

  for (const relativePath of authoredSources) {
    const source = read(relativePath);
    assert.match(source, /SPDX-License-Identifier: MPL-2\.0/, relativePath);
    assert.match(source, /Copyright 2026 Michael Wallace and contributors\./, relativePath);
  }
});

test('XcodeGen is pinned and Copy Bundle Resources receives only ui and src', () => {
  assert.equal(read('ios/.xcodegen-version').trim(), '2.46.0');
  const project = read('ios/project.yml');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(project, /deploymentTarget:\s*"16\.0"/);
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET:\s*"16\.0"/);
  assert.match(project, /- path: \.\.\/ui\s+type: folder\s+buildPhase: resources/);
  assert.match(project, /- path: \.\.\/src\s+type: folder\s+buildPhase: resources/);
  assert.match(project, /- path: RotorLens\/PrivacyInfo\.xcprivacy\s+buildPhase: resources/);
  assert.equal((project.match(/- path: \.\.\/(?:ui|src)/g) ?? []).length, 2);
  assert.doesNotMatch(project, /packages:/);
  assert.doesNotMatch(project, /package:/);
  assert.doesNotMatch(project, /\.\.\/(?:android|integration|test|tools)\b/);
  assert.match(project, /- \.\.\/LICENSE/);
  assert.match(project, /- \.\.\/NOTICE/);
  assert.match(read('ios/.gitignore'), /^RotorLens\.xcodeproj\/$/m);

  assert.match(notices, /\*\*XcodeGen 2\.46\.0\*\*/);
  assert.match(notices, /XcodeGen[\s\S]*?MIT[\s\S]*?Copyright \(c\)\s+2018 Yonas Kolb/);
  assert.match(notices, /XcodeGen[\s\S]*?neither[\s\S]*?linked, copied, or shipped in RotorLens/);
  assert.match(notices, /github\.com\/yonaskolb\/XcodeGen\/blob\/2\.46\.0\/LICENSE/);

  const generator = read('ios/scripts/generate-project.sh');
  assert.match(generator, /\.xcodegen-version/);
  assert.match(generator, /xcodegen generate --spec project\.yml/);
  assert.doesNotMatch(generator, /(?:brew|curl|wget|git clone)/);
});

test('Info.plist advertises only the supported open-in formats and no network entitlement', () => {
  const info = read('ios/RotorLens/Info.plist');
  for (const extension of ['bbl', 'bfl', 'txt', 'log']) {
    assert.match(info, new RegExp(`<string>${extension === 'txt' ? 'public\\.plain-text' : extension}</string>`));
  }
  assert.match(info, /app\.rotorlens\.blackbox-log/);
  assert.match(info, /Copyright © 2026 Michael Wallace and contributors\./);
  assert.match(info, /LSSupportsOpeningDocumentsInPlace[\s\S]*?<true\/>/);
  assert.match(info, /UIApplicationSupportsMultipleScenes[\s\S]*?<false\/>/);
  assert.doesNotMatch(info, /NSAppTransportSecurity|NSAllowsArbitraryLoads/);
  assert.doesNotMatch(info, /UISupportedExternalAccessoryProtocols|UIFileSharingEnabled/);
  assert.doesNotMatch(info, /NSBluetooth|NSLocalNetworkUsageDescription/);
});

test('the privacy manifest declares no collection, tracking, domains, or required-reason APIs', () => {
  const privacy = read('ios/RotorLens/PrivacyInfo.xcprivacy');
  assert.match(privacy, /NSPrivacyTracking[\s\S]*?<false\/>/);
  for (const key of [
    'NSPrivacyTrackingDomains',
    'NSPrivacyCollectedDataTypes',
    'NSPrivacyAccessedAPITypes'
  ]) {
    assert.match(privacy, new RegExp(`${key}[\\s\\S]*?<array\\/>`));
  }
});

test('the WebKit shell is ephemeral, local-origin-only, and fail-closed', () => {
  const controller = read('ios/RotorLens/ViewerViewController.swift');
  const handler = read('ios/RotorLens/WebAssetSchemeHandler.swift');
  const origin = read('ios/RotorLens/RotorLensOrigin.swift');
  const bridge = read('ios/RotorLens/NativeBridge.swift');
  const productionSources = [
    controller,
    handler,
    origin,
    bridge,
    read('ios/RotorLens/ImportStore.swift'),
    read('ios/RotorLens/PrivateStore.swift')
  ]
    .join('\n');

  assert.match(controller, /websiteDataStore = \.nonPersistent\(\)/);
  assert.match(controller, /url\.path == "\/ui\/index\.html"/);
  assert.match(handler, /default-src 'none'/);
  assert.match(handler, /connect-src 'self'/);
  assert.match(handler, /HTTPURLResponse/);
  assert.match(handler, /statusCode: 200/);
  assert.match(handler, /"Cache-Control": "no-store"/);
  assert.match(handler, /root == "ui" \|\| root == "src"/);
  assert.match(handler, /components\.count == 2/);
  assert.match(origin, /static let scheme = "rotorlens-app"/);
  assert.match(origin, /static let host = "app"/);
  assert.match(bridge, /RotorLensPlatform/);
  assert.match(bridge, /value: 'ios'/);
  assert.match(bridge, /pickFile/);
  assert.match(bridge, /WKScriptMessageHandlerWithReply/);
  assert.match(controller, /addScriptMessageHandler\([\s\S]*?contentWorld: \.page/);
  for (const method of [
    'readHistory', 'writeHistory', 'forgetHistory',
    'readSharing', 'writeSharing', 'forgetSharing'
  ]) {
    assert.match(bridge, new RegExp(`\\b${method}\\b`));
  }
  assert.doesNotMatch(productionSources, /URLSession|NWConnection|Network\b|MultipeerConnectivity/);
  assert.doesNotMatch(productionSources, /ExternalAccessory|EAAccessory|CoreBluetooth|DriverKit|IOKit/);
  assert.doesNotMatch(productionSources, /https?:\/\//);
});

test('iOS persistent records are separate, bounded, protected, atomic, and marked for backup exclusion', () => {
  const store = read('ios/RotorLens/PrivateStore.swift');
  const tests = read('ios/RotorLensTests/PrivateStoreTests.swift');

  assert.match(store, /applicationSupportDirectory/);
  assert.match(store, /flight-history\.json/);
  assert.match(store, /sharing\.json/);
  assert.match(store, /8 \* 1024 \* 1024/);
  assert.match(store, /64 \* 1024/);
  assert.match(store, /completeUntilFirstUserAuthentication/);
  assert.match(store, /isExcludedFromBackup = true/);
  assert.match(store, /handle\.synchronize\(\)/);
  assert.match(store, /Darwin\.rename/);
  assert.doesNotMatch(store, /replaceItemAt/,
    'a failed Foundation replacement may displace the last-good file to an opaque URL');
  assert.match(store, /flight-history\.writing/);
  assert.match(store, /sharing\.writing/);
  assert.match(store, /func forgetHistory\(\)/);
  assert.match(store, /func forgetSharing\(\)/);
  assert.doesNotMatch(store, /\.bbl|\.bfl|ImportStore|session/i);

  assert.match(tests, /testPersistsAndErasesHistoryAndSharingIndependently/);
  assert.match(tests, /testDirectoryAndCommittedFilesAreExcludedFromBackup/);
  assert.match(tests, /testCapsFailClosedWithoutReplacingTheLastGoodFile/);
  assert.match(tests, /testInitializationPurgesInterruptedStagingFiles/);
  assert.match(tests, /testFailedAtomicReplacementKeepsLastGoodFileAndEraseLeavesNoOrphan/);
});

test('imports are security-scoped, coordinated, capped, progressive, and generation-bound', () => {
  const store = read('ios/RotorLens/ImportStore.swift');
  const controller = read('ios/RotorLens/ViewerViewController.swift');
  const handler = read('ios/RotorLens/WebAssetSchemeHandler.swift');

  assert.match(store, /128 \* 1024 \* 1024/);
  assert.match(store, /startAccessingSecurityScopedResource/);
  assert.match(store, /stopAccessingSecurityScopedResource/);
  assert.match(store, /NSFileCoordinator/);
  assert.match(store, /options: \.withoutChanges/);
  assert.match(store, /latestGeneration == generation/);
  assert.match(store, /purgeCacheDirectory\(\)/);
  assert.match(store, /timeIntervalSince\(lastProgressDate\) >= 0\.2/);
  assert.match(controller, /rotorlens-import-started/);
  assert.match(controller, /rotorlens-import-progress/);
  assert.match(controller, /rotorlens-import-failed/);
  assert.match(controller, /rotorlens-file/);
  assert.match(handler, /snapshot\(for: generation\)/);
});
