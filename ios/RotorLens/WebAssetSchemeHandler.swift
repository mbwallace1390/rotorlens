// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import WebKit

/// Serves the checked-in ES-module tree and the one current import from a
/// single, non-network origin. Paths outside /ui, /src, and the exact current
/// /import/<generation> route are rejected.
final class WebAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    static let contentSecurityPolicy = [
        "default-src 'none'",
        "script-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "media-src 'self' blob:",
        "object-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
    ].joined(separator: "; ")

    private enum Payload {
        case file(url: URL, mimeType: String, byteCount: Int64, generation: UInt64?)
        case data(Data, mimeType: String)
    }

    private final class TaskState {
        private let lock = NSLock()
        private var cancelled = false
        private var completed = false

        func send(_ action: () -> Void) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !cancelled, !completed else { return false }
            action()
            return true
        }

        func complete(_ action: () -> Void) {
            lock.lock()
            defer { lock.unlock() }
            guard !cancelled, !completed else { return }
            completed = true
            action()
        }

        func cancel() {
            lock.lock()
            cancelled = true
            lock.unlock()
        }

        var isCancelled: Bool {
            lock.lock()
            let value = cancelled
            lock.unlock()
            return value
        }
    }

    private let resourceRootURL: URL
    private let importStore: ImportStore
    private let servingQueue = DispatchQueue(
        label: "app.rotorlens.web-assets",
        qos: .userInitiated
    )
    private let tasksLock = NSLock()
    private var taskStates: [ObjectIdentifier: TaskState] = [:]

    init(resourceRootURL: URL, importStore: ImportStore) {
        self.resourceRootURL = resourceRootURL.standardizedFileURL
        self.importStore = importStore
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let identifier = ObjectIdentifier(urlSchemeTask as AnyObject)
        let state = TaskState()

        tasksLock.lock()
        taskStates[identifier] = state
        tasksLock.unlock()

        servingQueue.async { [weak self] in
            guard let self else { return }
            self.serve(urlSchemeTask, identifier: identifier, state: state)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let identifier = ObjectIdentifier(urlSchemeTask as AnyObject)
        tasksLock.lock()
        let state = taskStates.removeValue(forKey: identifier)
        tasksLock.unlock()
        state?.cancel()
    }

    private func serve(
        _ task: WKURLSchemeTask,
        identifier: ObjectIdentifier,
        state: TaskState
    ) {
        defer { removeTask(identifier: identifier, state: state) }

        do {
            let payload = try resolvePayload(for: task.request)
            switch payload {
            case let .data(data, mimeType):
                let response = try successfulResponse(
                    for: task.request.url ?? RotorLensOrigin.viewerURL,
                    mimeType: mimeType,
                    byteCount: Int64(data.count)
                )
                guard state.send({ task.didReceive(response) }),
                      state.send({ task.didReceive(data) }) else {
                    return
                }
                state.complete { task.didFinish() }

            case let .file(fileURL, mimeType, byteCount, generation):
                let response = try successfulResponse(
                    for: task.request.url ?? RotorLensOrigin.viewerURL,
                    mimeType: mimeType,
                    byteCount: byteCount
                )
                guard state.send({ task.didReceive(response) }) else { return }
                try stream(
                    fileURL: fileURL,
                    requiredGeneration: generation,
                    to: task,
                    state: state
                )
                if let generation,
                   !importStore.isCurrent(generation: generation) {
                    throw URLError(.cancelled)
                }
                state.complete { task.didFinish() }
            }
        } catch {
            state.complete { task.didFailWithError(error) }
        }
    }

    private func stream(
        fileURL: URL,
        requiredGeneration: UInt64?,
        to task: WKURLSchemeTask,
        state: TaskState
    ) throws {
        let fileHandle = try FileHandle(forReadingFrom: fileURL)
        defer { try? fileHandle.close() }

        while !state.isCancelled {
            if let requiredGeneration,
               !importStore.isCurrent(generation: requiredGeneration) {
                throw URLError(.cancelled)
            }
            guard let data = try fileHandle.read(upToCount: ImportStore.copyBufferByteCount),
                  !data.isEmpty else {
                return
            }
            if let requiredGeneration,
               !importStore.isCurrent(generation: requiredGeneration) {
                throw URLError(.cancelled)
            }
            guard state.send({ task.didReceive(data) }) else { return }
        }
    }

    private func resolvePayload(for request: URLRequest) throws -> Payload {
        guard request.httpMethod == nil || request.httpMethod == "GET",
              let url = request.url,
              RotorLensOrigin.contains(url),
              url.query == nil else {
            throw URLError(.unsupportedURL)
        }

        let components = try safePathComponents(for: url)
        guard let root = components.first else {
            throw URLError(.fileDoesNotExist)
        }

        if root == "import" {
            guard components.count == 2,
                  let generation = UInt64(components[1]),
                  let snapshot = importStore.snapshot(for: generation) else {
                throw URLError(.fileDoesNotExist)
            }
            return .file(
                url: snapshot.fileURL,
                mimeType: "application/octet-stream",
                byteCount: snapshot.byteCount,
                generation: generation
            )
        }

        guard root == "ui" || root == "src", components.count >= 2 else {
            throw URLError(.fileDoesNotExist)
        }

        let allowedRootURL = resourceRootURL
            .appendingPathComponent(root, isDirectory: true)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let requestedURL = components.dropFirst().reduce(allowedRootURL) { partialURL, component in
            partialURL.appendingPathComponent(component, isDirectory: false)
        }
        .resolvingSymlinksInPath()
        .standardizedFileURL

        let allowedPrefix = allowedRootURL.path.hasSuffix("/")
            ? allowedRootURL.path
            : allowedRootURL.path + "/"
        guard requestedURL.path.hasPrefix(allowedPrefix) else {
            throw URLError(.noPermissionsToReadFile)
        }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: requestedURL.path, isDirectory: &isDirectory),
              !isDirectory.boolValue else {
            throw URLError(.fileDoesNotExist)
        }

        let mimeType = Self.mimeType(forExtension: requestedURL.pathExtension)
        if components == ["ui", "index.html"] {
            let sourceData = try Data(contentsOf: requestedURL, options: [.mappedIfSafe])
            return .data(try injectingContentSecurityPolicy(into: sourceData), mimeType: mimeType)
        }

        let values = try requestedURL.resourceValues(forKeys: [.fileSizeKey])
        return .file(
            url: requestedURL,
            mimeType: mimeType,
            byteCount: Int64(values.fileSize ?? 0),
            generation: nil
        )
    }

    private func safePathComponents(for url: URL) throws -> [String] {
        guard let encodedPath = URLComponents(
            url: url,
            resolvingAgainstBaseURL: false
        )?.percentEncodedPath,
              let decodedPath = encodedPath.removingPercentEncoding,
              decodedPath.first == "/",
              !decodedPath.contains("\\"),
              !decodedPath.contains("\0") else {
            throw URLError(.unsupportedURL)
        }

        let components = decodedPath
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw URLError(.noPermissionsToReadFile)
        }
        return components
    }

    private func injectingContentSecurityPolicy(into sourceData: Data) throws -> Data {
        guard var html = String(data: sourceData, encoding: .utf8),
              let headStart = html.range(
                of: "<head[^>]*>",
                options: [.regularExpression, .caseInsensitive]
              ) else {
            throw URLError(.cannotDecodeContentData)
        }

        let meta = "\n<meta http-equiv=\"Content-Security-Policy\" content=\"\(Self.contentSecurityPolicy)\">"
        html.insert(contentsOf: meta, at: headStart.upperBound)
        guard let encoded = html.data(using: .utf8) else {
            throw URLError(.cannotEncodeContentData)
        }
        return encoded
    }

    private func removeTask(identifier: ObjectIdentifier, state: TaskState) {
        tasksLock.lock()
        if taskStates[identifier] === state {
            taskStates.removeValue(forKey: identifier)
        }
        tasksLock.unlock()
    }

    /// Fetch exposes `response.ok` only when WebKit receives an HTTP response
    /// object with a successful status, even though the URL itself uses our
    /// private scheme. Plain URLResponse would make the shared host reject the
    /// bytes as status 0.
    private func successfulResponse(
        for url: URL,
        mimeType: String,
        byteCount: Int64
    ) throws -> HTTPURLResponse {
        let isText = mimeType.hasPrefix("text/")
            || mimeType == "application/json"
            || mimeType == "application/javascript"
        let contentType = isText ? "\(mimeType); charset=utf-8" : mimeType
        let headers = [
            "Cache-Control": "no-store",
            "Content-Length": String(byteCount),
            "Content-Security-Policy": Self.contentSecurityPolicy,
            "Content-Type": contentType,
            "X-Content-Type-Options": "nosniff"
        ]
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        ) else {
            throw URLError(.cannotParseResponse)
        }
        return response
    }

    private static func mimeType(forExtension pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm": return "text/html"
        case "css": return "text/css"
        case "js", "mjs": return "application/javascript"
        case "json", "map": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}
