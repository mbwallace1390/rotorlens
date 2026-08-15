// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import UIKit
import WebKit

final class ViewerViewController: UIViewController {
    private struct PageEvent {
        let name: String
        let detail: [String: Any]
        let generation: UInt64
    }

    private let importStore: ImportStore?
    private let importStoreError: Error?
    private let nativeBridge = NativeBridge()

    private var webView: WKWebView?
    private var schemeHandler: WebAssetSchemeHandler?
    private var currentGeneration: UInt64?
    private var pendingStartEvent: PageEvent?
    private var pendingTerminalEvent: PageEvent?
    private var pageReady = false
    private var isShutDown = false

    init() {
        do {
            importStore = try ImportStore()
            importStoreError = nil
        } catch {
            importStore = nil
            importStoreError = error
        }
        super.init(nibName: nil, bundle: nil)
        nativeBridge.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("RotorLens uses a programmatic UIKit scene")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.047, blue: 0.067, alpha: 1)

        guard let importStore else {
            showFatalError(
                title: "RotorLens could not create its private session cache.",
                detail: importStoreError?.localizedDescription
            )
            return
        }
        guard let resourceRootURL = Bundle.main.resourceURL,
              FileManager.default.fileExists(
                atPath: resourceRootURL.appendingPathComponent("ui/index.html").path
              ),
              FileManager.default.fileExists(
                atPath: resourceRootURL.appendingPathComponent("src").path
              ) else {
            showFatalError(
                title: "RotorLens viewer assets are missing.",
                detail: "Regenerate the Xcode project and rebuild from the repository root."
            )
            return
        }

        configureWebView(resourceRootURL: resourceRootURL, importStore: importStore)
    }

    func offerDocument(
        at sourceURL: URL,
        discardOwnedSourceAfterImport: Bool = false
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !isShutDown, let importStore else {
            if discardOwnedSourceAfterImport {
                Self.discardOwnedSource(at: sourceURL)
            }
            return
        }

        let displayName = RotorLensDocumentTypes.displayName(for: sourceURL)
        let generation = importStore.beginReplacement()
        currentGeneration = generation
        pendingStartEvent = nil
        pendingTerminalEvent = nil

        notifyImportStarted(name: displayName, total: -1, generation: generation)

        guard RotorLensDocumentTypes.supports(sourceURL) else {
            if discardOwnedSourceAfterImport {
                Self.discardOwnedSource(at: sourceURL)
            }
            notifyImportFailed(
                name: displayName,
                reason: .unreadable,
                generation: generation
            )
            return
        }

        importStore.importDocument(
            at: sourceURL,
            displayName: displayName,
            generation: generation,
            metadata: { [weak self] name, total, callbackGeneration in
                guard total >= 0 else { return }
                DispatchQueue.main.async {
                    self?.notifyImportStarted(
                        name: name,
                        total: total,
                        generation: callbackGeneration
                    )
                }
            },
            progress: { [weak self] copied, total, callbackGeneration in
                DispatchQueue.main.async {
                    self?.notifyImportProgress(
                        copied: copied,
                        total: total,
                        generation: callbackGeneration
                    )
                }
            },
            completion: { [weak self] outcome in
                if discardOwnedSourceAfterImport {
                    Self.discardOwnedSource(at: sourceURL)
                }
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch outcome {
                    case let .ready(snapshot):
                        self.notifyImportReady(snapshot)
                    case let .failed(failure):
                        guard failure != .replaced else { return }
                        self.notifyImportFailed(
                            name: displayName,
                            reason: failure,
                            generation: generation
                        )
                    }
                }
            }
        )
    }

    private static func discardOwnedSource(at sourceURL: URL) {
        let sandboxURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        let allowedRoots = [
            sandboxURL.appendingPathComponent("Documents/Inbox", isDirectory: true),
            FileManager.default.temporaryDirectory
        ]
        let resolvedSourceURL = sourceURL.resolvingSymlinksInPath().standardizedFileURL
        guard allowedRoots.contains(where: { rootURL in
            let resolvedRootURL = rootURL.resolvingSymlinksInPath().standardizedFileURL
            let prefix = resolvedRootURL.path.hasSuffix("/")
                ? resolvedRootURL.path
                : resolvedRootURL.path + "/"
            return resolvedSourceURL.path.hasPrefix(prefix)
        }) else {
            return
        }

        DispatchQueue.global(qos: .utility).async {
            try? FileManager.default.removeItem(at: resolvedSourceURL)
        }
    }

    func shutdown() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !isShutDown else { return }
        isShutDown = true
        pageReady = false
        importStore?.clear()
        webView?.stopLoading()
        webView?.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeBridge.messageName,
            contentWorld: .page
        )
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView = nil
        schemeHandler = nil
    }

    private func configureWebView(resourceRootURL: URL, importStore: ImportStore) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all

        let userContentController = WKUserContentController()
        userContentController.addUserScript(
            WKUserScript(
                source: nativeBridge.documentStartSource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        userContentController.addScriptMessageHandler(
            nativeBridge,
            contentWorld: .page,
            name: NativeBridge.messageName
        )
        configuration.userContentController = userContentController

        let schemeHandler = WebAssetSchemeHandler(
            resourceRootURL: resourceRootURL,
            importStore: importStore
        )
        configuration.setURLSchemeHandler(
            schemeHandler,
            forURLScheme: RotorLensOrigin.scheme
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.keyboardDismissMode = .interactive

        if #available(iOS 16.4, *) {
            #if DEBUG
            webView.isInspectable = true
            #endif
        }

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        self.schemeHandler = schemeHandler
        self.webView = webView
        webView.load(
            URLRequest(
                url: RotorLensOrigin.viewerURL,
                cachePolicy: .reloadIgnoringLocalCacheData,
                timeoutInterval: 30
            )
        )
    }

    private func notifyImportStarted(name: String, total: Int64, generation: UInt64) {
        guard acceptsCallback(generation: generation) else { return }
        let event = PageEvent(
            name: "rotorlens-import-started",
            detail: [
                "name": name,
                "total": NSNumber(value: total),
                "generation": NSNumber(value: generation)
            ],
            generation: generation
        )
        if pageReady {
            evaluate(event)
        } else {
            pendingStartEvent = event
        }
    }

    private func notifyImportProgress(copied: Int64, total: Int64, generation: UInt64) {
        guard pageReady, acceptsCallback(generation: generation) else { return }
        evaluate(
            PageEvent(
                name: "rotorlens-import-progress",
                detail: [
                    "copied": NSNumber(value: copied),
                    "total": NSNumber(value: total),
                    "generation": NSNumber(value: generation)
                ],
                generation: generation
            )
        )
    }

    private func notifyImportReady(_ snapshot: ImportSnapshot) {
        guard acceptsCallback(generation: snapshot.generation) else { return }
        let event = fileEvent(for: snapshot)
        if pageReady {
            evaluate(event)
        } else {
            pendingTerminalEvent = event
        }
    }

    private func notifyImportFailed(
        name: String,
        reason: ImportFailure,
        generation: UInt64
    ) {
        guard acceptsCallback(generation: generation) else { return }
        let event = PageEvent(
            name: "rotorlens-import-failed",
            detail: ["name": name, "reason": reason.pageReason],
            generation: generation
        )
        if pageReady {
            evaluate(event)
        } else {
            pendingTerminalEvent = event
        }
    }

    private func fileEvent(for snapshot: ImportSnapshot) -> PageEvent {
        PageEvent(
            name: "rotorlens-file",
            detail: [
                "name": snapshot.displayName,
                "url": "\(RotorLensOrigin.scheme)://\(RotorLensOrigin.host)/import/\(snapshot.generation)",
                "size": NSNumber(value: snapshot.byteCount)
            ],
            generation: snapshot.generation
        )
    }

    private func acceptsCallback(generation: UInt64) -> Bool {
        !isShutDown
            && currentGeneration == generation
            && importStore?.isCurrent(generation: generation) == true
    }

    private func flushPendingEvents() {
        guard pageReady else { return }

        if let pendingStartEvent,
           acceptsCallback(generation: pendingStartEvent.generation) {
            evaluate(pendingStartEvent)
        }
        self.pendingStartEvent = nil

        if let pendingTerminalEvent,
           acceptsCallback(generation: pendingTerminalEvent.generation) {
            evaluate(pendingTerminalEvent)
            self.pendingTerminalEvent = nil
            return
        }
        self.pendingTerminalEvent = nil

        if let snapshot = importStore?.currentSnapshot(),
           acceptsCallback(generation: snapshot.generation) {
            evaluate(fileEvent(for: snapshot))
        }
    }

    private func evaluate(_ event: PageEvent) {
        guard pageReady,
              acceptsCallback(generation: event.generation),
              JSONSerialization.isValidJSONObject(event.detail),
              let detailData = try? JSONSerialization.data(withJSONObject: event.detail),
              let nameData = try? JSONSerialization.data(
                withJSONObject: event.name,
                options: [.fragmentsAllowed]
              ),
              let detailJSON = String(data: detailData, encoding: .utf8),
              let nameJSON = String(data: nameData, encoding: .utf8) else {
            return
        }

        let script = "window.dispatchEvent(new CustomEvent(\(nameJSON),{detail:\(detailJSON)}));"
        webView?.evaluateJavaScript(script)
    }

    private func showFatalError(title: String, detail: String?) {
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .white
        label.font = .preferredFont(forTextStyle: .body)
        label.text = [title, detail].compactMap { $0 }.joined(separator: "\n\n")
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            label.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor)
        ])
    }
}

extension ViewerViewController: NativeBridgeDelegate {
    func nativeBridgeDidRequestDocumentPicker(_ bridge: NativeBridge) {
        guard presentedViewController == nil, !isShutDown else { return }
        let picker = UIDocumentPickerViewController(
            forOpeningContentTypes: RotorLensDocumentTypes.pickerTypes,
            asCopy: false
        )
        picker.delegate = self
        picker.allowsMultipleSelection = false
        picker.shouldShowFileExtensions = true
        present(picker, animated: true)
    }
}

extension ViewerViewController: UIDocumentPickerDelegate {
    func documentPicker(
        _ controller: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        guard let sourceURL = urls.first else { return }
        offerDocument(at: sourceURL)
    }
}

extension ViewerViewController: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard navigationAction.targetFrame?.isMainFrame == true,
              let url = navigationAction.request.url,
              RotorLensOrigin.contains(url),
              url.path == "/ui/index.html" else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        didStartProvisionalNavigation navigation: WKNavigation?
    ) {
        pageReady = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        pageReady = true
        flushPendingEvents()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false
        webView.load(
            URLRequest(
                url: RotorLensOrigin.viewerURL,
                cachePolicy: .reloadIgnoringLocalCacheData,
                timeoutInterval: 30
            )
        )
    }
}

extension ViewerViewController: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        nil
    }
}
