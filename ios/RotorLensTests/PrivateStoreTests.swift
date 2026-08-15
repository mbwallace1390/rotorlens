// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import XCTest
@testable import RotorLens

final class PrivateStoreTests: XCTestCase {
    private var temporaryDirectoryURL: URL!
    private var storeDirectoryURL: URL!

    override func setUpWithError() throws {
        temporaryDirectoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        storeDirectoryURL = temporaryDirectoryURL
            .appendingPathComponent("private", isDirectory: true)
        try FileManager.default.createDirectory(
            at: temporaryDirectoryURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryDirectoryURL)
        storeDirectoryURL = nil
        temporaryDirectoryURL = nil
    }

    func testPersistsAndErasesHistoryAndSharingIndependently() throws {
        let store = try PrivateStore(directoryURL: storeDirectoryURL)

        XCTAssertEqual(store.readHistory(), "")
        XCTAssertEqual(store.readSharing(), "")
        XCTAssertTrue(store.writeHistory("history-one"))
        XCTAssertTrue(store.writeSharing("sharing-one"))
        XCTAssertEqual(store.readHistory(), "history-one")
        XCTAssertEqual(store.readSharing(), "sharing-one")

        XCTAssertTrue(store.forgetSharing())
        XCTAssertEqual(store.readSharing(), "")
        XCTAssertEqual(store.readHistory(), "history-one")

        XCTAssertTrue(store.writeSharing("sharing-two"))
        XCTAssertTrue(store.forgetHistory())
        XCTAssertEqual(store.readHistory(), "")
        XCTAssertEqual(store.readSharing(), "sharing-two")
    }

    func testDirectoryAndCommittedFilesAreExcludedFromBackup() throws {
        let store = try PrivateStore(directoryURL: storeDirectoryURL)
        XCTAssertTrue(store.writeHistory("history"))
        XCTAssertTrue(store.writeSharing("sharing"))

        for url in [
            storeDirectoryURL,
            storeDirectoryURL.appendingPathComponent("flight-history.json"),
            storeDirectoryURL.appendingPathComponent("sharing.json")
        ] {
            let values = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
            XCTAssertEqual(values.isExcludedFromBackup, true, url.path)
        }
    }

    func testCapsFailClosedWithoutReplacingTheLastGoodFile() throws {
        let store = try PrivateStore(directoryURL: storeDirectoryURL)
        XCTAssertTrue(store.writeSharing("last-good"))
        XCTAssertFalse(
            store.writeSharing(
                String(repeating: "x", count: PrivateStore.maximumSharingByteCount + 1)
            )
        )
        XCTAssertEqual(store.readSharing(), "last-good")

        let historyURL = storeDirectoryURL.appendingPathComponent("flight-history.json")
        XCTAssertTrue(FileManager.default.createFile(atPath: historyURL.path, contents: Data()))
        let handle = try FileHandle(forWritingTo: historyURL)
        try handle.truncate(atOffset: UInt64(PrivateStore.maximumHistoryByteCount + 1))
        try handle.close()
        XCTAssertNil(store.readHistory())
    }

    func testInitializationPurgesInterruptedStagingFiles() throws {
        try FileManager.default.createDirectory(
            at: storeDirectoryURL,
            withIntermediateDirectories: true
        )
        for name in ["flight-history.writing", "sharing.writing"] {
            try Data("partial".utf8).write(
                to: storeDirectoryURL.appendingPathComponent(name)
            )
        }

        _ = try PrivateStore(directoryURL: storeDirectoryURL)

        for name in ["flight-history.writing", "sharing.writing"] {
            XCTAssertFalse(
                FileManager.default.fileExists(
                    atPath: storeDirectoryURL.appendingPathComponent(name).path
                )
            )
        }
    }

    func testFailedAtomicReplacementKeepsLastGoodFileAndEraseLeavesNoOrphan() throws {
        let initialStore = try PrivateStore(directoryURL: storeDirectoryURL)
        XCTAssertTrue(initialStore.writeHistory("last-good"))

        enum InjectedFailure: Error {
            case replacement
        }
        var replacementCalls = 0
        let failingStore = try PrivateStore(
            directoryURL: storeDirectoryURL,
            atomicReplace: { _, _ in
                replacementCalls += 1
                throw InjectedFailure.replacement
            }
        )

        XCTAssertFalse(failingStore.writeHistory("must-not-land"))
        XCTAssertEqual(replacementCalls, 1)
        XCTAssertEqual(failingStore.readHistory(), "last-good")
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: storeDirectoryURL.appendingPathComponent("flight-history.writing").path
            )
        )

        XCTAssertTrue(failingStore.forgetHistory())
        XCTAssertEqual(failingStore.readHistory(), "")
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: storeDirectoryURL.path),
            []
        )
    }
}
