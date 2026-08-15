// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import Darwin

/// The two persistent records the shared page already defines and serializes.
///
/// Raw logs never enter this directory. The history and sharing preference have
/// separate files and erase paths, matching Android and the controls on screen.
/// This class deliberately does not parse either JSON document: the tested page
/// owns the allowlists and schemas; native code only moves bounded UTF-8 text.
final class PrivateStore {
    typealias AtomicReplace = (_ stagedURL: URL, _ targetURL: URL) throws -> Void

    static let maximumHistoryByteCount = 8 * 1024 * 1024
    static let maximumSharingByteCount = 64 * 1024

    private struct Record {
        let fileName: String
        let stagingName: String
        let maximumByteCount: Int
    }

    private static let history = Record(
        fileName: "flight-history.json",
        stagingName: "flight-history.writing",
        maximumByteCount: maximumHistoryByteCount
    )
    private static let sharing = Record(
        fileName: "sharing.json",
        stagingName: "sharing.writing",
        maximumByteCount: maximumSharingByteCount
    )

    private let directoryURL: URL
    private let fileManager: FileManager
    private let atomicReplace: AtomicReplace
    private let lock = NSLock()

    convenience init(fileManager: FileManager = .default) throws {
        let applicationSupportURL = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        try self.init(
            directoryURL: applicationSupportURL.appendingPathComponent(
                "RotorLensPrivate",
                isDirectory: true
            ),
            fileManager: fileManager
        )
    }

    init(
        directoryURL: URL,
        fileManager: FileManager = .default,
        atomicReplace: AtomicReplace? = nil
    ) throws {
        self.directoryURL = directoryURL.standardizedFileURL
        self.fileManager = fileManager
        self.atomicReplace = atomicReplace ?? Self.replaceAtomically

        try fileManager.createDirectory(
            at: self.directoryURL,
            withIntermediateDirectories: true,
            attributes: [
                .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
            ]
        )
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: self.directoryURL.path
        )
        try Self.excludeFromBackup(self.directoryURL)

        // A staging file is data a write never committed. Purging it on every
        // launch prevents an interrupted update becoming an undocumented third
        // persistent record.
        try removeIfPresent(url(for: Self.history.stagingName))
        try removeIfPresent(url(for: Self.sharing.stagingName))
    }

    func readHistory() -> String? {
        withLock { read(Self.history) }
    }

    func writeHistory(_ text: String) -> Bool {
        withLock { write(text, to: Self.history) }
    }

    func forgetHistory() -> Bool {
        withLock { forget(Self.history) }
    }

    func readSharing() -> String? {
        withLock { read(Self.sharing) }
    }

    func writeSharing(_ text: String) -> Bool {
        withLock { write(text, to: Self.sharing) }
    }

    func forgetSharing() -> Bool {
        withLock { forget(Self.sharing) }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private func read(_ record: Record) -> String? {
        let sourceURL = url(for: record.fileName)
        guard fileManager.fileExists(atPath: sourceURL.path) else {
            return ""
        }

        do {
            let attributes = try fileManager.attributesOfItem(atPath: sourceURL.path)
            guard let size = (attributes[.size] as? NSNumber)?.uint64Value,
                  size <= UInt64(record.maximumByteCount) else {
                return nil
            }
            let data = try Data(contentsOf: sourceURL, options: .uncached)
            guard data.count <= record.maximumByteCount else {
                return nil
            }
            return String(data: data, encoding: .utf8)
        } catch {
            // Nil is not "no history". The shared page blocks writes after this
            // result so a transient read failure cannot overwrite an old file.
            return nil
        }
    }

    private func write(_ text: String, to record: Record) -> Bool {
        let data = Data(text.utf8)
        guard data.count <= record.maximumByteCount else {
            return false
        }

        let targetURL = url(for: record.fileName)
        let stagingURL = url(for: record.stagingName)
        do {
            try removeIfPresent(stagingURL)
            guard fileManager.createFile(
                atPath: stagingURL.path,
                contents: nil,
                attributes: [
                    .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
                ]
            ) else {
                return false
            }

            let handle = try FileHandle(forWritingTo: stagingURL)
            do {
                try handle.write(contentsOf: data)
                try handle.synchronize()
                try handle.close()
            } catch {
                try? handle.close()
                throw error
            }

            // Apple documents that replacement may reset this resource value,
            // so set it on the staged inode and again on the committed path.
            // The containing directory is excluded too, before any file exists.
            try Self.excludeFromBackup(stagingURL)
            // Both files are in the same private directory. POSIX rename is one
            // atomic name change: success leaves the staged inode at the fixed
            // target, while failure leaves the previous target untouched. That
            // stronger failure contract avoids Foundation's item-replacement edge
            // case where the last-good original can be displaced to an opaque
            // NSFileOriginalItemLocationKey recovery URL.
            try atomicReplace(stagingURL, targetURL)
            try? fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: targetURL.path
            )
            try? Self.excludeFromBackup(targetURL)
            return true
        } catch {
            try? removeIfPresent(stagingURL)
            return false
        }
    }

    private func forget(_ record: Record) -> Bool {
        let targetURL = url(for: record.fileName)
        let stagingURL = url(for: record.stagingName)
        try? removeIfPresent(stagingURL)
        try? removeIfPresent(targetURL)
        return !fileManager.fileExists(atPath: targetURL.path)
            && !fileManager.fileExists(atPath: stagingURL.path)
    }

    private func url(for fileName: String) -> URL {
        directoryURL.appendingPathComponent(fileName, isDirectory: false)
    }

    private func removeIfPresent(_ fileURL: URL) throws {
        if fileManager.fileExists(atPath: fileURL.path) {
            try fileManager.removeItem(at: fileURL)
        }
    }

    private static func excludeFromBackup(_ fileURL: URL) throws {
        var mutableURL = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try mutableURL.setResourceValues(values)
    }

    private static func replaceAtomically(_ stagedURL: URL, _ targetURL: URL) throws {
        try stagedURL.withUnsafeFileSystemRepresentation { stagedPath in
            guard let stagedPath else {
                throw CocoaError(.fileWriteInvalidFileName)
            }
            try targetURL.withUnsafeFileSystemRepresentation { targetPath in
                guard let targetPath else {
                    throw CocoaError(.fileWriteInvalidFileName)
                }
                guard Darwin.rename(stagedPath, targetPath) == 0 else {
                    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
                }
            }
        }
    }
}
