// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import XCTest
@testable import RotorLens

final class ImportStoreTests: XCTestCase {
    private var temporaryDirectoryURL: URL!

    override func setUpWithError() throws {
        temporaryDirectoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
            at: temporaryDirectoryURL,
            withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryDirectoryURL)
        temporaryDirectoryURL = nil
    }

    func testCopiesOneDocumentAndRetiresItsGenerationBeforeReplacement() throws {
        let cacheURL = temporaryDirectoryURL.appendingPathComponent("cache", isDirectory: true)
        let sourceURL = temporaryDirectoryURL.appendingPathComponent("flight.bbl")
        let sourceData = Data((0..<32_768).map { UInt8($0 % 251) })
        try sourceData.write(to: sourceURL)

        let store = try ImportStore(cacheDirectoryURL: cacheURL)
        let generation = store.beginReplacement()
        let result = waitForImport(
            store: store,
            sourceURL: sourceURL,
            displayName: "flight.bbl",
            generation: generation
        )

        guard case let .ready(snapshot) = result else {
            return XCTFail("Expected a ready import")
        }
        XCTAssertEqual(snapshot.generation, generation)
        XCTAssertEqual(snapshot.displayName, "flight.bbl")
        XCTAssertEqual(snapshot.byteCount, Int64(sourceData.count))
        XCTAssertEqual(try Data(contentsOf: snapshot.fileURL), sourceData)
        XCTAssertNotNil(store.snapshot(for: generation))

        let replacementGeneration = store.beginReplacement()
        XCTAssertNotEqual(replacementGeneration, generation)
        XCTAssertNil(store.snapshot(for: generation))
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshot.fileURL.path))
    }

    func testRejectsOversizedMetadataBeforeCopying() throws {
        let cacheURL = temporaryDirectoryURL.appendingPathComponent("cache", isDirectory: true)
        let sourceURL = temporaryDirectoryURL.appendingPathComponent("oversized.bfl")
        XCTAssertTrue(FileManager.default.createFile(atPath: sourceURL.path, contents: Data()))
        let handle = try FileHandle(forWritingTo: sourceURL)
        try handle.truncate(atOffset: UInt64(ImportStore.maximumByteCount + 1))
        try handle.close()

        let store = try ImportStore(cacheDirectoryURL: cacheURL)
        let generation = store.beginReplacement()
        let result = waitForImport(
            store: store,
            sourceURL: sourceURL,
            displayName: "oversized.bfl",
            generation: generation
        )

        guard case let .failed(failure) = result else {
            return XCTFail("Expected the oversized import to fail")
        }
        XCTAssertEqual(failure, .tooLarge)
        XCTAssertNil(store.snapshot(for: generation))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cacheURL.path), [])
    }

    func testInitializationPurgesVisibleAndHiddenCrashLeftovers() throws {
        let cacheURL = temporaryDirectoryURL.appendingPathComponent("cache", isDirectory: true)
        try FileManager.default.createDirectory(at: cacheURL, withIntermediateDirectories: true)
        try Data([1]).write(to: cacheURL.appendingPathComponent("import-1-leftover.bin"))
        try Data([2]).write(to: cacheURL.appendingPathComponent(".hidden-leftover"))

        _ = try ImportStore(cacheDirectoryURL: cacheURL)

        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cacheURL.path), [])
    }

    func testQueuedCopyCannotCommitAfterNewGenerationBegins() throws {
        let cacheURL = temporaryDirectoryURL.appendingPathComponent("cache", isDirectory: true)
        let sourceURL = temporaryDirectoryURL.appendingPathComponent("stale.log")
        try Data(repeating: 0x5a, count: 128 * 1024).write(to: sourceURL)

        let workerQueue = DispatchQueue(label: "app.rotorlens.tests.blocked-copy")
        let gate = DispatchSemaphore(value: 0)
        workerQueue.async { gate.wait() }
        let store = try ImportStore(
            cacheDirectoryURL: cacheURL,
            workerQueue: workerQueue
        )

        let staleGeneration = store.beginReplacement()
        let completion = expectation(description: "stale copy completes")
        var outcome: ImportOutcome?
        store.importDocument(
            at: sourceURL,
            displayName: "stale.log",
            generation: staleGeneration,
            metadata: { _, _, _ in },
            progress: { _, _, _ in },
            completion: {
                outcome = $0
                completion.fulfill()
            }
        )

        let currentGeneration = store.beginReplacement()
        gate.signal()
        wait(for: [completion], timeout: 3)

        guard let outcome = outcome else {
            return XCTFail("Expected the stale copy to complete")
        }
        guard case let .failed(failure) = outcome else {
            return XCTFail("Expected the stale copy to be replaced")
        }
        XCTAssertEqual(failure, .replaced)
        XCTAssertTrue(store.isCurrent(generation: currentGeneration))
        XCTAssertNil(store.snapshot(for: staleGeneration))
    }

    private func waitForImport(
        store: ImportStore,
        sourceURL: URL,
        displayName: String,
        generation: UInt64
    ) -> ImportOutcome {
        let completion = expectation(description: "document import completes")
        var outcome: ImportOutcome?
        store.importDocument(
            at: sourceURL,
            displayName: displayName,
            generation: generation,
            metadata: { _, _, _ in },
            progress: { _, _, _ in },
            completion: {
                outcome = $0
                completion.fulfill()
            }
        )
        wait(for: [completion], timeout: 5)
        return outcome ?? .failed(.unreadable)
    }
}
