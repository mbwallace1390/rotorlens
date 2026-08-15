// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation

struct ImportSnapshot {
    let generation: UInt64
    let fileURL: URL
    let displayName: String
    let byteCount: Int64
}

enum ImportFailure: Error, Equatable {
    case unreadable
    case tooLarge
    case replaced

    var pageReason: String {
        switch self {
        case .unreadable:
            return "unreadable"
        case .tooLarge:
            return "too-large"
        case .replaced:
            return "replaced"
        }
    }
}

enum ImportOutcome {
    case ready(ImportSnapshot)
    case failed(ImportFailure)
}

/// Owns one session-only imported document. The generation changes before a
/// replacement starts, so neither an older copy nor an older URL can become
/// current after the user selects a newer document.
final class ImportStore {
    static let maximumByteCount: Int64 = 128 * 1024 * 1024
    static let copyBufferByteCount = 64 * 1024

    typealias MetadataHandler = (_ name: String, _ total: Int64, _ generation: UInt64) -> Void
    typealias ProgressHandler = (_ copied: Int64, _ total: Int64, _ generation: UInt64) -> Void
    typealias CompletionHandler = (ImportOutcome) -> Void

    let cacheDirectoryURL: URL

    private let fileManager: FileManager
    private let workerQueue: DispatchQueue
    private let stateLock = NSLock()
    private var latestGeneration: UInt64 = 0
    private var currentSnapshotValue: ImportSnapshot?

    init(
        cacheDirectoryURL: URL? = nil,
        fileManager: FileManager = .default,
        workerQueue: DispatchQueue = DispatchQueue(
            label: "app.rotorlens.import-copy",
            qos: .userInitiated
        )
    ) throws {
        self.fileManager = fileManager
        self.workerQueue = workerQueue

        if let cacheDirectoryURL {
            self.cacheDirectoryURL = cacheDirectoryURL
        } else {
            guard let cachesURL = fileManager.urls(
                for: .cachesDirectory,
                in: .userDomainMask
            ).first else {
                throw CocoaError(.fileNoSuchFile)
            }
            self.cacheDirectoryURL = cachesURL.appendingPathComponent(
                "RotorLensSessionImports",
                isDirectory: true
            )
        }

        try fileManager.createDirectory(
            at: self.cacheDirectoryURL,
            withIntermediateDirectories: true
        )
        try purgeCacheDirectory()
    }

    /// Invalidates the old route before any work for its replacement begins.
    @discardableResult
    func beginReplacement() -> UInt64 {
        let retiredURL: URL?
        let generation: UInt64

        stateLock.lock()
        latestGeneration = latestGeneration == UInt64.max ? 1 : latestGeneration + 1
        generation = latestGeneration
        retiredURL = currentSnapshotValue?.fileURL
        currentSnapshotValue = nil
        stateLock.unlock()

        if let retiredURL {
            try? fileManager.removeItem(at: retiredURL)
        }
        return generation
    }

    func isCurrent(generation: UInt64) -> Bool {
        stateLock.lock()
        let current = latestGeneration == generation
        stateLock.unlock()
        return current
    }

    func snapshot(for generation: UInt64) -> ImportSnapshot? {
        stateLock.lock()
        let snapshot = currentSnapshotValue?.generation == generation
            ? currentSnapshotValue
            : nil
        stateLock.unlock()
        return snapshot
    }

    func currentSnapshot() -> ImportSnapshot? {
        stateLock.lock()
        let snapshot = currentSnapshotValue
        stateLock.unlock()
        return snapshot
    }

    /// Copies from a provider-owned URL under security scope and file
    /// coordination. Callbacks run on the private copy queue; UI callers must
    /// hop to the main actor before touching UIKit or WebKit.
    func importDocument(
        at sourceURL: URL,
        displayName: String,
        generation: UInt64,
        metadata: @escaping MetadataHandler,
        progress: @escaping ProgressHandler,
        completion: @escaping CompletionHandler
    ) {
        workerQueue.async { [weak self] in
            guard let self else {
                completion(.failed(.replaced))
                return
            }

            guard self.isCurrent(generation: generation) else {
                completion(.failed(.replaced))
                return
            }

            let accessedSecurityScope = sourceURL.startAccessingSecurityScopedResource()
            defer {
                if accessedSecurityScope {
                    sourceURL.stopAccessingSecurityScopedResource()
                }
            }

            var coordinationError: NSError?
            var coordinatedOutcome: ImportOutcome?
            let coordinator = NSFileCoordinator(filePresenter: nil)
            coordinator.coordinate(
                readingItemAt: sourceURL,
                options: .withoutChanges,
                error: &coordinationError
            ) { coordinatedURL in
                coordinatedOutcome = self.copyCoordinatedDocument(
                    at: coordinatedURL,
                    displayName: displayName,
                    generation: generation,
                    metadata: metadata,
                    progress: progress
                )
            }

            if let coordinatedOutcome {
                completion(coordinatedOutcome)
            } else {
                completion(.failed(.unreadable))
            }
        }
    }

    /// Invalidates the route synchronously. Any in-flight copy observes the new
    /// generation and removes its own staging file; the queued purge catches a
    /// process-lifetime leftover without blocking the main thread.
    func clear() {
        _ = beginReplacement()
        workerQueue.async { [weak self] in
            try? self?.purgeCacheDirectory()
        }
    }

    private func copyCoordinatedDocument(
        at sourceURL: URL,
        displayName: String,
        generation: UInt64,
        metadata: MetadataHandler,
        progress: ProgressHandler
    ) -> ImportOutcome {
        guard isCurrent(generation: generation) else {
            return .failed(.replaced)
        }

        let declaredByteCount: Int64
        do {
            let values = try sourceURL.resourceValues(forKeys: [.fileSizeKey])
            declaredByteCount = values.fileSize.map(Int64.init) ?? -1
        } catch {
            declaredByteCount = -1
        }

        metadata(displayName, declaredByteCount, generation)
        if declaredByteCount > Self.maximumByteCount {
            return .failed(.tooLarge)
        }

        let destinationURL = cacheDirectoryURL.appendingPathComponent(
            "import-\(generation)-\(UUID().uuidString).bin",
            isDirectory: false
        )
        var keepDestination = false
        defer {
            if !keepDestination {
                try? fileManager.removeItem(at: destinationURL)
            }
        }

        guard let inputStream = InputStream(url: sourceURL),
              let outputStream = OutputStream(url: destinationURL, append: false) else {
            return .failed(.unreadable)
        }

        inputStream.open()
        outputStream.open()
        defer {
            inputStream.close()
            outputStream.close()
        }

        var copiedByteCount: Int64 = 0
        var lastReportedByteCount: Int64 = -1
        var lastProgressDate = Date.distantPast
        var buffer = [UInt8](repeating: 0, count: Self.copyBufferByteCount)

        while true {
            guard isCurrent(generation: generation) else {
                return .failed(.replaced)
            }

            let readByteCount = buffer.withUnsafeMutableBufferPointer { pointer in
                guard let baseAddress = pointer.baseAddress else { return 0 }
                return inputStream.read(baseAddress, maxLength: pointer.count)
            }
            if readByteCount < 0 {
                return .failed(.unreadable)
            }
            if readByteCount == 0 {
                break
            }

            copiedByteCount += Int64(readByteCount)
            if copiedByteCount > Self.maximumByteCount {
                return .failed(.tooLarge)
            }

            var writtenByteCount = 0
            while writtenByteCount < readByteCount {
                let nextWriteCount = buffer.withUnsafeBufferPointer { pointer in
                    guard let baseAddress = pointer.baseAddress else { return -1 }
                    return outputStream.write(
                        baseAddress.advanced(by: writtenByteCount),
                        maxLength: readByteCount - writtenByteCount
                    )
                }
                if nextWriteCount <= 0 {
                    return .failed(.unreadable)
                }
                writtenByteCount += nextWriteCount
            }

            let now = Date()
            if now.timeIntervalSince(lastProgressDate) >= 0.2 {
                progress(copiedByteCount, declaredByteCount, generation)
                lastReportedByteCount = copiedByteCount
                lastProgressDate = now
            }
        }

        if lastReportedByteCount != copiedByteCount {
            progress(copiedByteCount, declaredByteCount, generation)
        }

        guard isCurrent(generation: generation) else {
            return .failed(.replaced)
        }

        let snapshot = ImportSnapshot(
            generation: generation,
            fileURL: destinationURL,
            displayName: displayName,
            byteCount: copiedByteCount
        )

        stateLock.lock()
        if latestGeneration == generation {
            currentSnapshotValue = snapshot
            keepDestination = true
        }
        stateLock.unlock()

        return keepDestination ? .ready(snapshot) : .failed(.replaced)
    }

    private func purgeCacheDirectory() throws {
        let contents = try fileManager.contentsOfDirectory(
            at: cacheDirectoryURL,
            includingPropertiesForKeys: nil,
            options: []
        )
        for itemURL in contents {
            try fileManager.removeItem(at: itemURL)
        }
    }
}
