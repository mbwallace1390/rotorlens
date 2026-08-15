// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import Foundation
import WebKit

protocol NativeBridgeDelegate: AnyObject {
    func nativeBridgeDidRequestDocumentPicker(_ bridge: NativeBridge)
}

final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let messageName = "rotorlens"

    /// Installed at document start so platform-specific legal data and storage
    /// capabilities are known before any bundled module runs. WebKit's reply
    /// handler makes each persistent operation a real JavaScript Promise; the
    /// page never reports success until Swift has completed the file operation.
    let documentStartSource: String

    weak var delegate: NativeBridgeDelegate?

    private let store: PrivateStore?
    private let workerQueue = DispatchQueue(label: "app.rotorlens.private-store")

    override convenience init() {
        self.init(store: try? PrivateStore())
    }

    init(store: PrivateStore?) {
        self.store = store
        documentStartSource = Self.makeDocumentStartSource(storageAvailable: store != nil)
        super.init()
    }

    private static func makeDocumentStartSource(storageAvailable: Bool) -> String {
        let storageMethods = storageAvailable ? #"""
        readHistory() { return call('readHistory'); },
        writeHistory(text) { return call('writeHistory', String(text)); },
        forgetHistory() { return call('forgetHistory'); },
        readSharing() { return call('readSharing'); },
        writeSharing(text) { return call('writeSharing', String(text)); },
        forgetSharing() { return call('forgetSharing'); },
        """# : ""

        return #"""
        (() => {
          'use strict';
          Object.defineProperty(globalThis, 'RotorLensPlatform', {
            value: 'ios', writable: false, configurable: false, enumerable: true
          });
          const call = (operation, text) => {
            const message = text === undefined ? {operation} : {operation, text};
            return globalThis.webkit.messageHandlers.rotorlens.postMessage(message);
          };
          const native = Object.freeze({
            pickFile() { void call('pickFile').catch(() => {}); },
        \#(storageMethods)
          });
          Object.defineProperty(globalThis, 'RotorLensNative', {
            value: native, writable: false, configurable: false, enumerable: true
          });
        })();
        """#
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == Self.messageName,
              message.frameInfo.isMainFrame,
              RotorLensOrigin.contains(message.frameInfo.request.url),
              let body = message.body as? [String: Any],
              let operation = body["operation"] as? String else {
            replyHandler(nil, "RotorLens rejected an invalid native request.")
            return
        }

        if operation == "pickFile" {
            delegate?.nativeBridgeDidRequestDocumentPicker(self)
            replyHandler(NSNumber(value: true), nil)
            return
        }

        guard let store else {
            replyHandler(nil, "RotorLens private storage is unavailable.")
            return
        }

        let text = body["text"] as? String
        guard (operation != "writeHistory" && operation != "writeSharing") || text != nil else {
            replyHandler(nil, "RotorLens rejected a storage write without text.")
            return
        }

        workerQueue.async {
            let result: Any
            switch operation {
            case "readHistory":
                result = store.readHistory() ?? NSNull()
            case "writeHistory":
                result = NSNumber(value: store.writeHistory(text ?? ""))
            case "forgetHistory":
                result = NSNumber(value: store.forgetHistory())
            case "readSharing":
                result = store.readSharing() ?? NSNull()
            case "writeSharing":
                result = NSNumber(value: store.writeSharing(text ?? ""))
            case "forgetSharing":
                result = NSNumber(value: store.forgetSharing())
            default:
                DispatchQueue.main.async {
                    replyHandler(nil, "RotorLens rejected an unsupported native operation.")
                }
                return
            }

            DispatchQueue.main.async {
                replyHandler(result, nil)
            }
        }
    }
}
