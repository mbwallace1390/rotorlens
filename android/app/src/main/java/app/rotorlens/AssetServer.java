package app.rotorlens;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves the viewer's own files to the WebView over an https origin.
 *
 * The viewer is loaded from a real https URL rather than file://, because
 * browsers refuse ES module imports and fetch from file:// origins — the app
 * would render and its JavaScript would never run. Nothing is fetched from the
 * network: every response here comes from the APK's assets or the app's own
 * cache, and requests for any other host are declined so the WebView cannot
 * reach out even if a page tried.
 *
 * The imported log is served from this same origin at {@link #importPath(long)}
 * rather than being pushed into JavaScript as a string. An 8 MB log base64
 * encoded into an evaluateJavascript call is an 11 MB string built and parsed on
 * the UI thread; a fetch is neither.
 */
final class AssetServer {

    /** Requests to any other host are refused. */
    static final String HOST = "appassets.rotorlens.app";

    static final String ORIGIN = "https://" + HOST;

    /** Prefix for immutable, generation-bound imported-log URLs. */
    private static final String IMPORT_PREFIX = "/import/";

    private static final Map<String, String> CONTENT_TYPES = new HashMap<>();

    static {
        CONTENT_TYPES.put("html", "text/html");
        CONTENT_TYPES.put("mjs", "text/javascript");
        CONTENT_TYPES.put("js", "text/javascript");
        CONTENT_TYPES.put("css", "text/css");
        CONTENT_TYPES.put("json", "application/json");
        CONTENT_TYPES.put("svg", "image/svg+xml");
        CONTENT_TYPES.put("png", "image/png");
        CONTENT_TYPES.put("woff2", "font/woff2");
    }

    private final AssetManager assets;
    private final ImportStore imports;

    AssetServer(AssetManager assets, ImportStore imports) {
        this.assets = assets;
        this.imports = imports;
    }

    private static String contentTypeOf(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0) {
            return "application/octet-stream";
        }
        String type = CONTENT_TYPES.get(path.substring(dot + 1).toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), null);
    }

    private static WebResourceResponse respond(String contentType, InputStream body) {
        Map<String, String> headers = new HashMap<>();
        // The viewer is entirely local; nothing here should ever be cached across
        // installs or reachable cross-origin.
        headers.put("Cache-Control", "no-store");
        headers.put("Access-Control-Allow-Origin", ORIGIN);
        WebResourceResponse response =
                new WebResourceResponse(contentType, "utf-8", 200, "OK", headers, body);
        return response;
    }

    /** A URL that can only resolve to this exact committed import. */
    static String importPath(long id) {
        return IMPORT_PREFIX + id;
    }

    /**
     * @return a response, or null to let the WebView handle the request itself
     *         (which, for any host other than ours, means refusing it).
     */
    WebResourceResponse serve(Uri url) {
        if (url == null || !HOST.equals(url.getHost())) {
            return null;
        }

        String path = url.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/ui/index.html";
        }

        if (path.startsWith(IMPORT_PREFIX)) {
            long id;
            try {
                String suffix = path.substring(IMPORT_PREFIX.length());
                if (suffix.isEmpty() || suffix.indexOf('/') >= 0) {
                    return notFound();
                }
                id = Long.parseLong(suffix);
            } catch (NumberFormatException malformed) {
                return notFound();
            }

            File file = imports.current(id);
            if (file == null) {
                return notFound();
            }
            try {
                return respond("application/octet-stream", new FileInputStream(file));
            } catch (IOException error) {
                return notFound();
            }
        }

        // Strip the leading slash and refuse any traversal outside the asset tree.
        String assetPath = path.substring(1);
        if (assetPath.contains("..")) {
            return notFound();
        }

        try {
            return respond(contentTypeOf(assetPath), assets.open(assetPath));
        } catch (IOException missing) {
            return notFound();
        }
    }
}
