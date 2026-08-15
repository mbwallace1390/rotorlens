package app.rotorlens;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.concurrent.atomic.AtomicLong;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

/**
 * The whole native app.
 *
 * RotorLens is the web viewer in `ui/`, running against the engine in `src/`.
 * This class exists only to do the things a web page cannot: receive a shared or
 * opened `.bbl`, show the system file picker, and serve the viewer over an
 * origin where ES modules work.
 *
 * Keeping it this thin is deliberate. Everything implemented here is code the
 * repository's test suite cannot reach, so the rule is that nothing decides
 * anything in Java — it transports one session-only import and exposes the two
 * small private stores through a narrow bridge. All decoding, analysis, storage
 * policy, and presentation happen in JavaScript, where they are tested.
 */
public final class MainActivity extends ComponentActivity {

    /**
     * The floor on how often a copy reports its progress to the page.
     *
     * Reading a full dataflash over USB mass storage runs at roughly 800 KiB/s,
     * so a large dump takes minutes. Reporting every buffer would be thousands
     * of events; this keeps evaluateJavascript out of the renderer's way while
     * staying frequent enough that a bar never looks stuck.
     *
     * IT IS A FLOOR, NOT A PERIOD, and the difference was measured rather than
     * assumed. On a real board — 85,538,816 bytes at 784 KiB/s, 106 seconds —
     * the page received 219 progress events with a MEDIAN GAP OF 489 ms, about
     * twice this value. A 64 KiB buffer at that rate arrives every ~82 ms, so
     * the first buffer past the 200 ms floor should land near 245 ms; the extra
     * comes from somewhere between the read loop and the UI thread and has not
     * been chased, because 219 events over a two-minute copy is ample for the
     * only thing this feeds.
     *
     * Do not treat 200 as the delivery interval. Anything that needs a real
     * period — a rate estimate, a time remaining — must measure the gaps it
     * actually receives.
     */
    private static final long PROGRESS_INTERVAL_MS = 200;

    private WebView webView;
    private ImportStore imports;
    private HistoryStore history;
    private ActivityResultLauncher<String[]> picker;

    /** Monotonic claim on the import slot; only the newest selection may commit. */
    private final AtomicLong importGeneration = new AtomicLong();

    /** Interrupted on replacement/destroy so cooperative providers stop promptly. */
    private volatile Thread importThread;

    /** Start/terminal events waiting for the page's module listeners. UI thread only. */
    private final PendingImportEvents pendingImports = new PendingImportEvents();

    /**
     * Whether the page has loaded and registered the listeners in ui/app.mjs.
     *
     * Only read or written on the UI thread — onPageStarted, onPageFinished and
     * the runOnUiThread block in importFrom are all UI-thread callbacks — so no
     * synchronization is needed.
     */
    private boolean pageReady;

    /** Bridge exposed to the page. See ui/host.mjs for the contract. */
    private final class NativeBridge {
        /** Lets shared UI render only the notices and instructions this shell ships. */
        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public void pickFile() {
            // Called from the WebView's JavaScript thread; the picker must be
            // launched on the UI thread.
            runOnUiThread(() -> picker.launch(new String[]{"*/*"}));
        }

        /**
         * The flight history file, verbatim.
         *
         * These three run on the WebView's JavaScript thread — never the UI
         * thread — and HistoryStore is synchronized, so they are safe to call
         * synchronously from the page. Under a megabyte of text moves fast
         * enough that offering an asynchronous version would only add a way for
         * the page to render before its own history arrived.
         *
         * Nothing here inspects the string. What may be in it is decided by
         * `exportHistory` in src/analysis/flight-history.mjs, which builds every
         * record from a documented allowlist; a Java-side opinion about the
         * contents would be a second, untested implementation of the privacy
         * rules.
         */
        @JavascriptInterface
        public String readHistory() {
            return history.read();
        }

        @JavascriptInterface
        public boolean writeHistory(String text) {
            return history.write(text);
        }

        @JavascriptInterface
        public boolean forgetHistory() {
            return history.forget();
        }

        /**
         * The sharing preference and the per-helicopter identities, verbatim.
         *
         * <p><b>Nothing in this app sends anything anywhere.</b> The manifest
         * has no INTERNET or sensitive platform permission, so these three
         * methods move a few hundred bytes between the page and a file in this
         * app's own private storage, and no code in this build acts on what they
         * carry. The preference records a choice for a transport that does not
         * exist yet, deliberately: the consent, the identity and the deletion
         * path are provable before anything can be sent, rather than retrofitted
         * onto an installed base afterwards.
         *
         * <p>Like the history above, nothing here inspects the string. What may
         * be in it is decided in ui/app.mjs, where the test suite can reach it.
         */
        @JavascriptInterface
        public String readSharing() {
            return history.readSharing();
        }

        @JavascriptInterface
        public boolean writeSharing(String text) {
            return history.writeSharing(text);
        }

        /** Erases the sharing identity, leaving the flights alone. */
        @JavascriptInterface
        public boolean forgetSharing() {
            return history.forgetSharing();
        }
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled") // The packaged viewer is JavaScript; origin/network are locked below.
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        imports = new ImportStore(getCacheDir());
        // getFilesDir(), not getCacheDir(): history and the sharing preference
        // may outlive the session, and the system empties the cache whenever it
        // wants storage back. See HistoryStore for the rest of the reasoning.
        history = new HistoryStore(getFilesDir());
        picker = registerForActivityResult(
                new ActivityResultContracts.OpenDocument(),
                uri -> {
                    if (uri != null) {
                        importFrom(uri);
                    }
                });

        webView = new WebView(this);
        setContentView(webView);
        // targetSdk 36 lays the window out edge to edge on Android 15+ and ignores
        // the theme's statusBarColor/navigationBarColor. The page's own
        // env(safe-area-inset-*) padding covers display cutouts but not the
        // status or navigation bars, because WebView does not fold system-bar
        // insets into those. The strip this leaves shows android:windowBackground,
        // which is the same surface the page paints, so the seam is invisible.
        webView.setFitsSystemWindows(true);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // Everything is served from the APK; nothing may reach the filesystem or
        // the network, so the log cannot leave the device even by accident.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(true);
        // Large logs draw a lot of canvas; give the page a real viewport.
        settings.setUseWideViewPort(false);
        settings.setSupportZoom(false);

        // Debug builds expose the WebView to chrome://inspect, which is by far the
        // fastest way to diagnose "the page is blank" on a device.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        final AssetServer server = new AssetServer(getAssets(), imports);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view,
                    WebResourceRequest request) {
                return server.serve(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Refuse navigation anywhere but our own origin. There is nothing
                // else this app should ever load.
                Uri url = request.getUrl();
                return url == null || !AssetServer.HOST.equals(url.getHost());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                // A reload, a back navigation, or a renderer restart gives us a
                // new document with no listeners on it yet. Without this, a stale
                // pageReady sends events into a document that cannot hear them —
                // the same bug in a form that is far harder to reproduce.
                pageReady = false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Module scripts are deferred, so ui/app.mjs has run and called
                // onHostFile() before the load event that brings us here.
                pageReady = true;
                String script = pendingImports.drain(importGeneration.get());
                if (script != null) {
                    view.evaluateJavascript(script, null);
                }
            }
        });

        webView.addJavascriptInterface(new NativeBridge(), "RotorLensNative");
        webView.loadUrl(AssetServer.ORIGIN + "/ui/index.html");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Give the page's real modal first refusal. The callback is
                // asynchronous, so navigation belongs inside it; finishing here
                // would close the activity before JavaScript could dismiss the
                // consent dialog.
                webView.evaluateJavascript(
                        "Boolean(window.RotorLensHandleBack&&window.RotorLensHandleBack())",
                        handled -> {
                            if ("true".equals(handled)) {
                                return;
                            }
                            if (webView.canGoBack()) {
                                webView.goBack();
                            } else {
                                finish();
                            }
                        });
            }
        });

        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** Picks up a log the user opened or shared into RotorLens. */
    private void handleIntent(Intent intent) {
        if (intent == null) {
            return;
        }

        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = streamOf(intent);
            if (uri == null) {
                // The share sheet offers RotorLens for text/plain, because some
                // providers give a .txt log that type. A share with no stream is
                // somebody sharing a string, not a log. Say so rather than coming
                // to the foreground and doing nothing.
                long generation = retireImportSlot();
                notifyFailure("that share", "no-file", generation);
                return;
            }
        }

        if (uri != null) {
            importFrom(uri);
        }
    }

    /**
     * Reads EXTRA_STREAM as a Uri, or null if it is anything else.
     *
     * The share sheet hands this app an intent built by another app, so the
     * extra is not ours and is not guaranteed to be a Uri. The single-argument
     * getParcelableExtra infers its return type from the assignment and casts
     * blind, which turns a malformed or hostile share into a ClassCastException
     * inside the share handler rather than the "that share contained text"
     * message the caller already knows how to show. API 33's typed overload
     * returns null instead; below that, reading it as a Parcelable and checking
     * the type gets the same result without the implicit cast.
     */
    @SuppressWarnings("deprecation")
    private static Uri streamOf(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }

        Parcelable extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return extra instanceof Uri ? (Uri) extra : null;
    }

    private void importFrom(Uri uri) {
        final long generation = retireImportSlot();
        // retireImportSlot unlinks the prior cache entry immediately (an
        // already-open response keeps its own descriptor). Tell the page now so
        // it can abort a superseded fetch and retire stale tuning advice while a
        // slow provider is still answering metadata calls.
        final String provisionalName = fallbackDisplayName(uri);
        notifyImportStarted(provisionalName, -1, generation);

        // Neither the copy nor the name lookup is UI-thread work. displayNameOf
        // is a binder round trip into the providing app's ContentProvider, which
        // for a cloud provider is a network call — and on a cold start it would
        // run before onCreate returns and before the WebView has drawn anything.
        Thread thread = new Thread(() -> {
            final String name = displayNameOf(uri);
            final long total = sizeOf(uri);

            if (!isCurrentImport(generation)) {
                return;
            }

            // Refresh the provisional label and add a determinate total when the
            // provider supplied one. The page treats this as metadata for the
            // same generation and does not resurrect the retired log.
            runOnUiThread(() -> {
                if (isCurrentImport(generation)) {
                    notifyImportStarted(name, total, generation);
                }
            });

            if (total > ImportStore.MAXIMUM_BYTES) {
                runOnUiThread(() -> {
                    if (isCurrentImport(generation)) {
                        importThread = null;
                        notifyFailure(name, "too-large", generation);
                    }
                });
                return;
            }

            // Only read and written on the import thread.
            final long[] lastReportedAt = {0};
            final ImportStore.Result result = imports.accept(
                    getContentResolver(), uri, name,
                    () -> isCurrentImport(generation), copied -> {
                long now = SystemClock.uptimeMillis();
                if (now - lastReportedAt[0] < PROGRESS_INTERVAL_MS) {
                    return;
                }
                lastReportedAt[0] = now;
                runOnUiThread(() -> {
                    if (isCurrentImport(generation)) {
                        notifyImportProgress(copied, total, generation);
                    }
                });
            });

            runOnUiThread(() -> {
                if (!isCurrentImport(generation)) {
                    return;
                }
                importThread = null;
                if (result.ready) {
                    notifyPage(result.displayName, result.id, result.byteLength, generation);
                } else if (!"cancelled".equals(result.reason)) {
                    notifyFailure(name, result.reason, generation);
                }
            });
        }, "rotorlens-import-" + generation);
        importThread = thread;
        thread.start();
    }

    /**
     * Cancels and unlinks the previous import, returning the new slot version.
     *
     * This method only runs on the UI thread. The provider copy itself is not
     * synchronized with it: interrupt plus the generation predicate make the
     * old worker close and delete its staging file without making lifecycle or
     * a new selection wait on a slow ContentProvider read.
     */
    private long retireImportSlot() {
        long generation = importGeneration.incrementAndGet();
        // Both the start and terminal event queued before the page registered
        // its listeners belong to the generation being retired. Without this, a
        // singleTask ACTION_VIEW arriving during cold start can replay file A
        // over file B when onPageFinished finally fires.
        pendingImports.retire(generation);
        Thread previousThread = importThread;
        importThread = null;
        if (previousThread != null) {
            previousThread.interrupt();
        }

        // There is one cache slot and one screen. A worker from an older
        // generation cannot commit after this clear.
        imports.clear();
        return generation;
    }

    private boolean isCurrentImport(long generation) {
        return importGeneration.get() == generation && !isFinishing() && !isDestroyed();
    }

    /** A non-blocking label used until the provider answers DISPLAY_NAME. */
    private static String fallbackDisplayName(Uri uri) {
        String last = uri == null ? null : uri.getLastPathSegment();
        return last == null || last.isEmpty() ? "log" : last;
    }

    private String displayNameOf(Uri uri) {
        // Ask for the one column that is read. A null projection makes a document
        // provider marshal every column it has across the binder.
        String[] projection = {OpenableColumns.DISPLAY_NAME};
        try (Cursor cursor = getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (name != null && !name.isEmpty()) {
                        return name;
                    }
                }
            }
        } catch (Exception ignored) {
            // Fall through to the path's last segment.
        }

        String last = uri.getLastPathSegment();
        return last == null ? "log" : last;
    }

    /**
     * Byte length behind {@code uri}, or -1 when the provider will not say.
     *
     * SIZE is documented as optional and a provider may return null for it, so
     * an unknown size is a normal outcome rather than a failure. Everything
     * downstream has to work without it — a progress bar that needs a total it
     * cannot get would be worse than the blank screen it replaces.
     */
    private long sizeOf(Uri uri) {
        String[] projection = {OpenableColumns.SIZE};
        try (Cursor cursor = getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (column >= 0 && !cursor.isNull(column)) {
                    long size = cursor.getLong(column);
                    if (size > 0) {
                        return size;
                    }
                }
            }
        } catch (Exception ignored) {
            // An unknown size is expected, not exceptional.
        }
        return -1;
    }

    /** Sends or queues the newest start metadata for this exact import. */
    private void dispatchImportStart(String script, long generation) {
        if (!isCurrentImport(generation)) {
            return;
        }
        if (pageReady) {
            webView.evaluateJavascript(script, null);
        } else {
            pendingImports.queueStart(generation, script);
        }
    }

    /**
     * Sends or queues a ready/failure event for this exact import.
     *
     * On cold start this is replayed after the queued start event, in one
     * evaluateJavascript call, so the page can establish the generation before
     * opening the file or reporting its failure.
     */
    private void dispatchTerminal(String script, long generation) {
        if (!isCurrentImport(generation)) {
            return;
        }
        if (pageReady) {
            webView.evaluateJavascript(script, null);
        } else {
            pendingImports.queueTerminal(generation, script);
        }
    }

    /**
     * Sends an event only if the page can hear it right now.
     *
     * Progress is worth nothing late: a held "37% copied" replayed after the
     * copy has finished would contradict the completion event that follows it,
     * and only one event can be held. Reserving that slot for the terminal
     * event — ready or failed — is what keeps a cold start correct.
     */
    private void dispatchLive(String script) {
        if (pageReady) {
            webView.evaluateJavascript(script, null);
        }
    }

    /**
     * Tells the page a copy has begun, and how big it will be if that is known.
     *
     * Reading a log off a flight controller in mass-storage mode is slow — a
     * full dataflash took over two minutes on real hardware — and until this
     * existed the app showed nothing at all for the whole of it. The person who
     * knows this app best still read that blank screen as "it's broken", twice.
     *
     * `total` is -1 when the provider will not say, which is not an error and
     * must not be shown as one: the page counts bytes instead of pretending to
     * a percentage it cannot compute.
     */
    private void notifyImportStarted(String name, long total, long generation) {
        dispatchImportStart(
                "window.dispatchEvent(new CustomEvent('rotorlens-import-started',{detail:{"
                + "name:" + quote(name) + ","
                + "total:" + total + ","
                + "generation:" + generation
                + "}}))", generation);
    }

    /** Reports bytes copied so far. Throttled by PROGRESS_INTERVAL_MS. */
    private void notifyImportProgress(long copied, long total, long generation) {
        dispatchLive("window.dispatchEvent(new CustomEvent('rotorlens-import-progress',{detail:{"
                + "copied:" + copied + ","
                + "total:" + total + ","
                + "generation:" + generation
                + "}}))");
    }

    /** Tells the page a log is ready. It fetches the bytes itself. */
    private void notifyPage(String name, long id, long byteLength, long generation) {
        dispatchTerminal("window.dispatchEvent(new CustomEvent('rotorlens-file',{detail:{"
                + "name:" + quote(name) + ","
                + "url:" + quote(AssetServer.importPath(id)) + ","
                + "size:" + byteLength
                + "}}))", generation);
    }

    /**
     * Tells the page an import did not happen.
     *
     * `reason` is a stable code the page turns into words: "unreadable" for a
     * copy that failed, "no-file" for a share that carried text and no stream,
     * and "too-large" when the document exceeds the bounded in-memory reader.
     */
    private void notifyFailure(String name, String reason, long generation) {
        dispatchTerminal("window.dispatchEvent(new CustomEvent('rotorlens-import-failed',{detail:{"
                + "name:" + quote(name) + ","
                + "reason:" + quote(reason)
                + "}}))", generation);
    }

    /** JSON-safe string literal; a filename can contain anything. */
    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (character < 0x20 || character > 0x7e) {
                        out.append(String.format("\\u%04x", (int) character));
                    } else {
                        out.append(character);
                    }
            }
        }
        return out.append('"').toString();
    }

    @Override
    protected void onDestroy() {
        // The log is somebody's flight, and possibly their location history. It
        // does not outlive the session that opened it.
        retireImportSlot();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
