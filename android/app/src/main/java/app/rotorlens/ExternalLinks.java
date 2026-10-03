package app.rotorlens;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/**
 * The links that leave the viewer, and only those, for the user's own browser.
 *
 * About & Legal links to the source repository and to each bundled component's
 * project. Inside the WebView those taps did nothing: the shell refuses every
 * navigation off the app's origin, and nothing else opened them. A pilot reading
 * where the source is could not follow the link to it.
 *
 * <p><b>Why an exact list and not "any https link".</b> RotorLens has no INTERNET
 * permission, so the app cannot send a flight anywhere. A URL handed to the
 * browser is a message the browser then sends: if any https URL could leave,
 * anything the page can read could be put in a query string and sent from there,
 * and the missing permission would stop meaning what the privacy policy says it
 * means. A fixed list of the URLs the legal screen shows carries nothing the
 * page chose.
 *
 * <p>This is a second copy of URLs that live in ui/legal-data.mjs, kept because
 * the shell must not trust the page to say what may leave. A second copy drifts,
 * so test/android-shell.test.mjs fails if this set and the links the legal screen
 * can render ever differ, in either direction.
 *
 * <p>Nothing here decides anything about a flight. It answers one question:
 * is this tap on one of these addresses.
 */
final class ExternalLinks {

    /** Exactly what About & Legal renders as a link, on any platform. */
    static final Set<String> ALLOWED = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "https://github.com/mbwallace1390/rotorlens",
            "https://developer.android.com/jetpack/androidx/releases",
            "https://github.com/JetBrains/kotlin",
            "https://github.com/Kotlin/kotlinx.coroutines",
            "https://github.com/JetBrains/java-annotations",
            "https://github.com/google/guava")));

    private ExternalLinks() {
    }

    /**
     * Whether a navigation should be handed to the browser.
     *
     * @param url the canonical URL the WebView reports, compared exactly
     * @param userGesture whether a person's tap started it; a script navigating
     *        on its own never throws the user into another app
     */
    static boolean opensInBrowser(String url, boolean userGesture) {
        return userGesture && url != null && ALLOWED.contains(url);
    }
}
