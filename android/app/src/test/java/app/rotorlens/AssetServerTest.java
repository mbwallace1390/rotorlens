package app.rotorlens;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Which requests the asset server answers from the APK, and which it refuses.
 *
 * Returning null from shouldInterceptRequest does not refuse anything: it hands
 * the request to the WebView, which then loads it itself. The only thing that
 * kept a subresource from reaching another host was the missing INTERNET
 * permission. Everything that is not this exact origin is now answered with a
 * refusal by the shell, so the permission is no longer the only barrier.
 */
public final class AssetServerTest {

    @Test
    public void theAppOriginIsServed() {
        assertTrue(AssetServer.isAppOrigin("https", "appassets.rotorlens.app", -1));
        assertTrue("an explicit default port is the same origin",
                AssetServer.isAppOrigin("https", "appassets.rotorlens.app", 443));
    }

    @Test
    public void foreignHostsAreRefused() {
        assertFalse(AssetServer.isAppOrigin("https", "github.com", -1));
        assertFalse(AssetServer.isAppOrigin("https", "example.com", -1));
        assertFalse(AssetServer.isAppOrigin("https", "rotorlens.app", -1));
    }

    @Test
    public void lookalikeHostsAreRefused() {
        assertFalse(AssetServer.isAppOrigin("https", "appassets.rotorlens.app.example.com", -1));
        assertFalse(AssetServer.isAppOrigin("https", "evil.appassets.rotorlens.app", -1));
        assertFalse(AssetServer.isAppOrigin("https", "appassets-rotorlens.app", -1));
        assertFalse(AssetServer.isAppOrigin("https", "", -1));
        assertFalse(AssetServer.isAppOrigin("https", null, -1));
    }

    @Test
    public void theRightHostOnAnotherSchemeOrPortIsAnotherOrigin() {
        assertFalse("plain http is not the origin the viewer runs on",
                AssetServer.isAppOrigin("http", "appassets.rotorlens.app", -1));
        assertFalse(AssetServer.isAppOrigin("https", "appassets.rotorlens.app", 8443));
        assertFalse(AssetServer.isAppOrigin("http", "appassets.rotorlens.app", 80));
        for (String scheme : new String[]{
                "file", "content", "data", "blob", "javascript", "intent", "ws", "wss", "ftp",
                "", null}) {
            assertFalse(String.valueOf(scheme),
                    AssetServer.isAppOrigin(scheme, "appassets.rotorlens.app", -1));
        }
    }

    @Test
    public void canonicalCaseDifferencesDoNotMatter() {
        // Chromium lowercases scheme and host before the shell sees them, so this
        // is belt and braces rather than a path a real request takes.
        assertTrue(AssetServer.isAppOrigin("HTTPS", "AppAssets.RotorLens.app", -1));
    }
}
