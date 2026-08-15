// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import XCTest
@testable import RotorLens

final class RotorLensDocumentTypesTests: XCTestCase {
    func testSupportedExtensionsAreExactAndCaseInsensitive() {
        for path in ["flight.bbl", "flight.BFL", "flight.txt", "flight.LoG"] {
            XCTAssertTrue(RotorLensDocumentTypes.supports(URL(fileURLWithPath: path)), path)
        }
        for path in ["flight.bin", "flight.csv", "flight", "flight.bbl.zip"] {
            XCTAssertFalse(RotorLensDocumentTypes.supports(URL(fileURLWithPath: path)), path)
        }
    }

    func testDocumentStartBridgeExposesOnlyPhaseOneCapabilities() {
        let source = NativeBridge.documentStartSource
        XCTAssertTrue(source.contains("RotorLensPlatform"))
        XCTAssertTrue(source.contains("value: 'ios'"))
        XCTAssertTrue(source.contains("pickFile"))
        XCTAssertFalse(source.contains("readHistory"))
        XCTAssertFalse(source.contains("writeHistory"))
        XCTAssertFalse(source.contains("readSharing"))
        XCTAssertFalse(source.contains("writeSharing"))
    }
}
