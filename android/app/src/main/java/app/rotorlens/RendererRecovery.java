package app.rotorlens;

/**
 * Decides whether a dead WebView renderer is worth replacing.
 *
 * The renderer is a separate process. When it runs out of memory on a large log,
 * or the system reclaims it while the app is in the background, the WebView tells
 * the shell; until this existed nothing listened, and Android then killed the
 * whole app with it.
 *
 * Replacing the viewer cannot loop on a log, because the shell never re-offers
 * the log that was open when the renderer died. It could loop on a renderer that
 * dies by itself before any page loads, so a replacement must finish loading a
 * page before another loss earns another replacement. UI thread only.
 */
final class RendererRecovery {

    /** True until a loss; set again whenever a page finishes loading. */
    private boolean loadedSinceLastLoss = true;

    /** The current renderer finished loading the viewer. */
    void pageLoaded() {
        loadedSinceLastLoss = true;
    }

    /**
     * Records a loss and says whether to build a replacement viewer.
     *
     * The first loss always gets one. A second loss before the replacement
     * finished loading does not: that renderer never worked, and rebuilding it
     * again would only repeat the failure.
     */
    boolean mayRebuildAfterLoss() {
        boolean allowed = loadedSinceLastLoss;
        loadedSinceLastLoss = false;
        return allowed;
    }
}
