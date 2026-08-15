// SPDX-License-Identifier: MPL-2.0
// Copyright 2026 Michael Wallace and contributors.

import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private weak var viewerViewController: ViewerViewController?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let viewerViewController = ViewerViewController()
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = viewerViewController
        window.makeKeyAndVisible()

        self.viewerViewController = viewerViewController
        self.window = window

        if let context = connectionOptions.urlContexts.first {
            viewerViewController.offerDocument(
                at: context.url,
                discardOwnedSourceAfterImport: !context.options.openInPlace
            )
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let context = URLContexts.first else { return }
        viewerViewController?.offerDocument(
            at: context.url,
            discardOwnedSourceAfterImport: !context.options.openInPlace
        )
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        viewerViewController?.shutdown()
    }
}
