// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation

enum RotorLensOrigin {
    static let scheme = "rotorlens-app"
    static let host = "app"

    static let viewerURL: URL = {
        guard let url = URL(string: "\(scheme)://\(host)/ui/index.html") else {
            preconditionFailure("The fixed RotorLens viewer URL must be valid")
        }
        return url
    }()

    static func contains(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme?.lowercased() == scheme && url.host?.lowercased() == host
    }
}
