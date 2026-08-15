package app.rotorlens;

import android.content.ContentResolver;
import android.net.Uri;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.function.BooleanSupplier;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Holds the log currently being viewed.
 *
 * A shared or picked Uri is only readable while its permission grant lasts, and
 * a grant from a share intent can expire before the user has finished looking at
 * the flight. The bytes are therefore copied into the app's own cache once, and
 * everything afterwards reads that copy.
 *
 * Exactly one log is kept. This is a viewer, not a library: holding on to
 * previous imports would accumulate flight data — which is somebody's location
 * history — for no benefit the user asked for.
 */
final class ImportStore {

    private static final String FILE_PREFIX = "import-";
    private static final String FILE_SUFFIX = ".bin";

    /** Refuse absurd inputs rather than filling the device's storage. */
    static final long MAXIMUM_BYTES = 128L * 1024L * 1024L;

    /**
     * Process-wide, so two imports can never land on the same name and so the
     * purge below can never delete a file this process wrote.
     */
    private static final AtomicLong SEQUENCE = new AtomicLong();

    /** Whether this process has already cleared what a previous run left. */
    private static final AtomicBoolean PURGED = new AtomicBoolean(false);

    private final File directory;
    private File current;
    private long currentId;

    /** The result of one copy, including the immutable URL identity it earned. */
    static final class Result {
        final boolean ready;
        final String reason;
        final long id;
        final String displayName;
        final long byteLength;

        private Result(boolean ready, String reason, long id, String displayName,
                long byteLength) {
            this.ready = ready;
            this.reason = reason;
            this.id = id;
            this.displayName = displayName;
            this.byteLength = byteLength;
        }

        static Result ready(long id, String displayName, long byteLength) {
            return new Result(true, null, id, displayName, byteLength);
        }

        static Result failed(String reason) {
            return new Result(false, reason, -1, null, 0);
        }
    }

    ImportStore(File cacheDirectory) {
        this.directory = new File(cacheDirectory, "imports");
        purgeOnce();
    }

    /**
     * Deletes whatever a previous run left behind — once per process.
     *
     * onDestroy is not guaranteed: a low-memory kill, an uncaught exception on
     * the import thread, or a swipe from recents on some builds leaves the last
     * flight in the cache with nothing to remove it. The app promises a log does
     * not outlive the session that opened it, and this is what makes that true
     * rather than merely usual.
     *
     * Once per process, not once per instance: the constructor runs again on
     * every activity recreation, so purging there would drop the user's open log
     * when they rotate the phone.
     */
    private void purgeOnce() {
        if (PURGED.getAndSet(true)) {
            return;
        }

        // Synchronous and on the main thread by design: it runs before any
        // accept() can start, so a rotating filename can never be deleted out
        // from under a copy, and unlinking a couple of small files costs nothing.
        File[] stale = directory.listFiles();
        if (stale != null) {
            for (File file : stale) {
                file.delete();
            }
        }
    }

    synchronized File current(long id) {
        return current != null && currentId == id ? current : null;
    }

    /**
     * Reports how much has been copied so far.
     *
     * Called on the import thread, once per buffer — thousands of times for a
     * full dataflash dump. Throttling belongs to the caller, which is the only
     * side that knows how expensive its reporting is.
     */
    interface Progress {
        void copied(long bytes);
    }

    /**
     * Copies the content behind {@code uri} into the cache.
     *
     * @param progress notified as bytes land; may be null
     * @param active true only while this is still the newest selection
     * @return the committed import, or a stable failure/cancellation reason
     */
    Result accept(ContentResolver resolver, Uri uri, String name, BooleanSupplier active,
            Progress progress) {
        if (uri == null) {
            return Result.failed("unreadable");
        }
        if (!directory.exists() && !directory.mkdirs()) {
            return Result.failed("unreadable");
        }

        // A new file every time, never the same name twice.
        //
        // AssetServer hands the WebView an open FileInputStream and the WebView
        // drains it lazily over the life of the fetch. Reopening one fixed path
        // with FileOutputStream truncates the inode under that descriptor and
        // splices two logs together — and a truncated Blackbox log still looks
        // like a valid one. Unlinking the previous file is safe for the same
        // reason: an open descriptor keeps reading the original inode.
        long id = SEQUENCE.incrementAndGet();
        File destination = new File(directory, FILE_PREFIX + id + FILE_SUFFIX);
        long copied = 0;

        try (InputStream input = resolver.openInputStream(uri);
             OutputStream output = new FileOutputStream(destination)) {
            if (input == null) {
                destination.delete();
                return Result.failed("unreadable");
            }

            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (Thread.currentThread().isInterrupted() || !active.getAsBoolean()) {
                    output.close();
                    destination.delete();
                    return Result.failed("cancelled");
                }
                copied += read;
                if (copied > MAXIMUM_BYTES) {
                    output.close();
                    destination.delete();
                    return Result.failed("too-large");
                }
                output.write(buffer, 0, read);
                if (progress != null) {
                    progress.copied(copied);
                }
            }
        } catch (IOException | SecurityException error) {
            destination.delete();
            return Result.failed(active.getAsBoolean() ? "unreadable" : "cancelled");
        }

        File previous;
        synchronized (this) {
            // The generation may have changed after the final read. Check while
            // publishing so an older thread can never become current after the
            // newer selection has cleared or committed its own file.
            if (!active.getAsBoolean()) {
                destination.delete();
                return Result.failed("cancelled");
            }
            previous = current;
            current = destination;
            currentId = id;
        }

        if (previous != null) {
            previous.delete();
        }
        String safeName = name == null || name.isEmpty() ? "log" : name;
        return Result.ready(id, safeName, copied);
    }

    /**
     * Drops the imported log without waiting for an in-progress copy.
     *
     * accept() performs the slow provider read outside this monitor. That is
     * load-bearing: onDestroy runs on the UI thread and must never wait minutes
     * for a USB/cloud ContentProvider to finish a copy.
     */
    void clear() {
        File previous;
        synchronized (this) {
            previous = current;
            current = null;
            currentId = 0;
        }
        if (previous != null) {
            previous.delete();
        }

        // Also unlink an in-progress destination owned by the thread we just
        // cancelled. Android permits unlinking an open file; its descriptor can
        // finish/close, but no cache entry survives an Activity teardown. The
        // generation check in accept() prevents that thread publishing it later.
        File[] staged = directory.listFiles();
        if (staged != null) {
            for (File file : staged) {
                if (file.getName().startsWith(FILE_PREFIX)
                        && file.getName().endsWith(FILE_SUFFIX)) {
                    file.delete();
                }
            }
        }
    }
}
