// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import UniformTypeIdentifiers

enum RotorLensDocumentTypes {
    static let blackboxLog = UTType(
        importedAs: "app.rotorlens.blackbox-log",
        conformingTo: .data
    )

    static let pickerTypes: [UTType] = [blackboxLog, .plainText]
    static let supportedExtensions: Set<String> = ["bbl", "bfl", "txt", "log"]

    static func supports(_ url: URL) -> Bool {
        supportedExtensions.contains(url.pathExtension.lowercased())
    }

    static func displayName(for url: URL) -> String {
        let candidate = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        return candidate.isEmpty ? "Blackbox log" : candidate
    }
}
