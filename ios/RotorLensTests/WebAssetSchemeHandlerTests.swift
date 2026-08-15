// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import WebKit
import XCTest
@testable import RotorLens

final class WebAssetSchemeHandlerTests: XCTestCase {
    private final class SchemeTaskRecorder: NSObject, WKURLSchemeTask {
        let request: URLRequest
        let completion: XCTestExpectation
        private(set) var response: URLResponse?
        private(set) var receivedData = Data()
        private(set) var receivedError: Error?
        private(set) var didFinishSuccessfully = false
        var onFirstData: (() -> Void)?
        private var receivedFirstData = false

        init(url: URL, completion: XCTestExpectation) {
            request = URLRequest(url: url)
            self.completion = completion
        }

        func didReceive(_ response: URLResponse) {
            self.response = response
        }

        func didReceive(_ data: Data) {
            receivedData.append(data)
            if !receivedFirstData {
                receivedFirstData = true
                onFirstData?()
            }
        }

        func didFinish() {
            didFinishSuccessfully = true
            completion.fulfill()
        }

        func didFailWithError(_ error: Error) {
            receivedError = error
            completion.fulfill()
        }
    }

    private var temporaryDirectoryURL: URL!
    private var resourceRootURL: URL!
    private var importStore: ImportStore!
    private var handler: WebAssetSchemeHandler!

    override func setUpWithError() throws {
        temporaryDirectoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        resourceRootURL = temporaryDirectoryURL.appendingPathComponent("resources", isDirectory: true)
        let uiURL = resourceRootURL.appendingPathComponent("ui", isDirectory: true)
        let srcURL = resourceRootURL.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: uiURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: srcURL, withIntermediateDirectories: true)
        try Data("<!doctype html><html><head></head><body>viewer</body></html>".utf8)
            .write(to: uiURL.appendingPathComponent("index.html"))
        try Data("export const value = 1;".utf8)
            .write(to: srcURL.appendingPathComponent("module.mjs"))

        importStore = try ImportStore(
            cacheDirectoryURL: temporaryDirectoryURL.appendingPathComponent("cache", isDirectory: true)
        )
        handler = WebAssetSchemeHandler(
            resourceRootURL: resourceRootURL,
            importStore: importStore
        )
    }

    override func tearDownWithError() throws {
        handler = nil
        importStore = nil
        try? FileManager.default.removeItem(at: temporaryDirectoryURL)
        temporaryDirectoryURL = nil
    }

    func testServesModuleWithJavaScriptMimeType() throws {
        let task = start("rotorlens-app://app/src/module.mjs")
        wait(for: [task.completion], timeout: 3)

        XCTAssertNil(task.receivedError)
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(task.response?.mimeType, "application/javascript")
        XCTAssertEqual(String(data: task.receivedData, encoding: .utf8), "export const value = 1;")
    }

    func testInjectsFailClosedContentSecurityPolicyIntoIndex() throws {
        let task = start("rotorlens-app://app/ui/index.html")
        wait(for: [task.completion], timeout: 3)

        let html = try XCTUnwrap(String(data: task.receivedData, encoding: .utf8))
        XCTAssertNil(task.receivedError)
        XCTAssertEqual((task.response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(
            (task.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Cache-Control"),
            "no-store"
        )
        XCTAssertTrue(html.contains("Content-Security-Policy"))
        XCTAssertTrue(html.contains("default-src 'none'"))
        XCTAssertTrue(html.contains("connect-src 'self'"))
        XCTAssertFalse(html.contains("connect-src https:"))
    }

    func testRejectsTraversalAndForeignOrigins() {
        for rawURL in [
            "rotorlens-app://app/ui/%2e%2e/secret.txt",
            "https://example.invalid/ui/index.html",
            "rotorlens-app://other/ui/index.html"
        ] {
            let task = start(rawURL)
            wait(for: [task.completion], timeout: 3)
            XCTAssertNotNil(task.receivedError, rawURL)
            XCTAssertNil(task.response, rawURL)
        }
    }

    func testImportRouteIsBoundToCurrentGeneration() throws {
        let sourceURL = temporaryDirectoryURL.appendingPathComponent("flight.bbl")
        let sourceData = Data(repeating: 0x42, count: 4096)
        try sourceData.write(to: sourceURL)
        let generation = importStore.beginReplacement()
        let imported = expectation(description: "import is ready")
        importStore.importDocument(
            at: sourceURL,
            displayName: "flight.bbl",
            generation: generation,
            metadata: { _, _, _ in },
            progress: { _, _, _ in },
            completion: { outcome in
                guard case .ready = outcome else {
                    return XCTFail("Expected import to succeed")
                }
                imported.fulfill()
            }
        )
        wait(for: [imported], timeout: 3)

        let currentTask = start("rotorlens-app://app/import/\(generation)")
        wait(for: [currentTask.completion], timeout: 3)
        XCTAssertNil(currentTask.receivedError)
        XCTAssertEqual((currentTask.response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertEqual(currentTask.receivedData, sourceData)

        _ = importStore.beginReplacement()
        let staleTask = start("rotorlens-app://app/import/\(generation)")
        wait(for: [staleTask.completion], timeout: 3)
        XCTAssertNotNil(staleTask.receivedError)
    }

    func testReplacementCancelsAnImportRouteAlreadyBeingStreamed() throws {
        let sourceURL = temporaryDirectoryURL.appendingPathComponent("slow-flight.bbl")
        try Data(repeating: 0x39, count: 512 * 1024).write(to: sourceURL)
        let generation = importStore.beginReplacement()
        let imported = expectation(description: "stream test import is ready")
        importStore.importDocument(
            at: sourceURL,
            displayName: "slow-flight.bbl",
            generation: generation,
            metadata: { _, _, _ in },
            progress: { _, _, _ in },
            completion: { outcome in
                if case .ready = outcome {
                    imported.fulfill()
                }
            }
        )
        wait(for: [imported], timeout: 3)

        let task = start("rotorlens-app://app/import/\(generation)") { [importStore] in
            _ = importStore?.beginReplacement()
        }
        wait(for: [task.completion], timeout: 3)

        XCTAssertNotNil(task.receivedError)
        XCTAssertFalse(task.didFinishSuccessfully)
        XCTAssertLessThanOrEqual(task.receivedData.count, ImportStore.copyBufferByteCount)
    }

    private func start(
        _ rawURL: String,
        onFirstData: (() -> Void)? = nil
    ) -> SchemeTaskRecorder {
        let completion = expectation(description: rawURL)
        let task = SchemeTaskRecorder(
            url: URL(string: rawURL)!,
            completion: completion
        )
        task.onFirstData = onFirstData
        handler.webView(WKWebView(frame: .zero), start: task)
        return task
    }
}
