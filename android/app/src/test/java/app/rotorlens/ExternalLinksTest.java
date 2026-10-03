package app.rotorlens;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Which tapped links leave the viewer for the user's own browser.
 *
 * The set itself is compared with what About & Legal actually renders by
 * test/android-shell.test.mjs; this file pins the rule applied to it.
 */
public final class ExternalLinksTest {

    private static final String REPOSITORY = "https://github.com/mbwallace1390/rotorlens";

    @Test
    public void aTappedLegalLinkOpensInTheBrowser() {
        assertTrue(ExternalLinks.opensInBrowser(REPOSITORY, true));
        assertTrue(ExternalLinks.opensInBrowser(
                "https://developer.android.com/jetpack/androidx/releases", true));
        assertTrue(ExternalLinks.opensInBrowser("https://github.com/JetBrains/kotlin", true));
    }

    @Test
    public void nothingOpensWithoutAUserGesture() {
        // A script navigating on its own must not be able to throw the user into
        // another app, even to a URL that a tap would open.
        assertFalse(ExternalLinks.opensInBrowser(REPOSITORY, false));
    }

    @Test
    public void onlyTheExactUrlsTheLegalScreenShowsAreAllowed() {
        // A URL is a message. If any https URL could be handed to the browser,
        // anything the page can read could be put in one and sent from there,
        // and the missing INTERNET permission would stop promising anything.
        assertFalse(ExternalLinks.opensInBrowser(REPOSITORY + "?flight=1", true));
        assertFalse(ExternalLinks.opensInBrowser(REPOSITORY + "#home", true));
        assertFalse(ExternalLinks.opensInBrowser(REPOSITORY + "/issues", true));
        assertFalse(ExternalLinks.opensInBrowser(REPOSITORY + "/", true));
        assertFalse(ExternalLinks.opensInBrowser("https://github.com/someone-else/rotorlens", true));
        assertFalse(ExternalLinks.opensInBrowser("https://example.com/", true));
        assertFalse(ExternalLinks.opensInBrowser("https://user@github.com/mbwallace1390/rotorlens", true));
        assertFalse(ExternalLinks.opensInBrowser("https://github.com:8443/mbwallace1390/rotorlens", true));
    }

    @Test
    public void noOtherSchemeEverLeaves() {
        for (String url : new String[]{
                "http://github.com/mbwallace1390/rotorlens",
                "intent://github.com/mbwallace1390/rotorlens#Intent;scheme=https;end",
                "javascript:alert(1)",
                "file:///sdcard/Download/LOG00012.bbl",
                "content://com.android.externalstorage.documents/document/primary%3ALOG.bbl",
                "data:text/html,hello",
                "market://details?id=app.rotorlens",
                "https://appassets.rotorlens.app/ui/index.html",
                "",
                null}) {
            assertFalse(String.valueOf(url), ExternalLinks.opensInBrowser(url, true));
        }
    }

    @Test
    public void everyAllowedUrlIsAPlainHttpsAddress() {
        for (String url : ExternalLinks.ALLOWED) {
            assertTrue(url, url.startsWith("https://"));
            assertFalse(url, url.contains("?"));
            assertFalse(url, url.contains("#"));
            assertFalse(url, url.contains("@"));
            assertFalse(url, url.contains(AssetServer.HOST));
        }
        assertFalse("an empty allowlist would pass every check above vacuously",
                ExternalLinks.ALLOWED.isEmpty());
    }
}
