package app.rotorlens;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The two small records RotorLens may keep after the app closes: saved flight
 * summaries and the separate sharing preference/identities file.
 *
 * A single file of about 2.5 kB per remembered flight, holding the numbers a
 * before/after comparison is made from. What may be in it is decided in
 * `src/analysis/flight-history.mjs` and written by `exportHistory`, which builds
 * every record from a documented allowlist — so this class never inspects, never
 * merges and never rewrites the contents. It moves a string to and from a file
 * and does nothing else, because everything that decides anything belongs where
 * the test suite can reach it.
 *
 * ## Why here rather than in the WebView
 *
 * `docs/PRIVACY_POLICY.md` promises "no browser storage of any kind — no
 * localStorage, no IndexedDB, no web databases", and
 * `test/privacy-claims.test.mjs` refuses to let those words appear in anything
 * that ships. This file is what makes that promise keepable while the history
 * still exists:
 *
 *  - {@code getFilesDir()} is the app's own private storage. It survives an app
 *    update, which is the whole point of a history, and it is removed by
 *    uninstall and by Android's <em>Clear storage</em>.
 *  - {@code android:allowBackup="false"} in the manifest keeps it out of
 *    Google's cloud backup, and {@code android:dataExtractionRules} keeps it out
 *    of a phone-to-phone migration. Both are needed and the second is the one
 *    that is easy to miss: at targetSdk 31 and above, allowBackup="false" alone
 *    does not stop a device-to-device transfer, so with only that line this file
 *    would have followed its owner onto a new handset and "nothing leaves your
 *    phone" would have become false with no app code changing at all. See
 *    res/xml/data_extraction_rules.xml.
 *  - Each record has one fixed name, and "forget everything" invokes and checks
 *    the two unlinks independently so one failure cannot hide the other.
 *
 * ## The second file, and why it is in this class
 *
 * Beside the history sits {@code sharing.json}: a sharing preference and one
 * random identity per helicopter, written by the shared-measurements screen in
 * ui/app.mjs. It is a few hundred bytes and it is here rather than in a class of
 * its own for one reason — the page's "Forget everything" invokes both
 * {@link #forget()} and {@link #forgetSharing()}, and a second store with an
 * independent lifetime is how that control quietly stops meaning everything.
 *
 * <p><b>Nothing in this app sends anything anywhere.</b> The app has no INTERNET
 * or sensitive platform permission, so the preference below records a choice
 * and nothing acts on it. That is deliberate: the choice, the identity and the
 * deletion path are built and provable first, and the transport is a separate
 * change made later and on purpose.
 */
final class HistoryStore {

    private static final String FILE_NAME = "flight-history.json";

    /**
     * The sharing preference and per-aircraft identities.
     *
     * Separate from the history file because it has a different lifetime in one
     * direction only: erasing the sharing identity must not throw away a pilot's
     * flights, while erasing everything must take both. Merging it into the
     * history JSON would have made the first of those impossible without
     * rewriting a file this class is not allowed to understand.
     */
    private static final String SHARING_NAME = "sharing.json";

    /**
     * Its own cap, three orders of magnitude below the history's.
     *
     * The sharing file holds a boolean and one 100-bit identity per helicopter —
     * a few hundred bytes for any real collection, and a few kilobytes for an
     * absurd one. Sharing the history's 8 MB ceiling would have meant this
     * backstop caught nothing a defect could plausibly produce.
     */
    private static final int MAXIMUM_SHARING_BYTES = 64 * 1024;

    /**
     * The half-written file, which never becomes the real one.
     *
     * A write that is interrupted — low battery, a kill, a full disk — must not
     * leave a truncated history behind, because a truncated JSON file loses
     * every flight rather than the last one. The new contents land here first
     * and are renamed over the old file only once they are complete on disk.
     */
    private static final String PENDING_NAME = "flight-history.writing";

    /** The same protection for the sharing file. See {@link #PENDING_NAME}. */
    private static final String SHARING_PENDING_NAME = "sharing.writing";

    /**
     * Refuse an absurd write rather than filling the device.
     *
     * The engine caps the history at 200 flights per aircraft and a flight is
     * about 2.5 kB, so a real file is well under a megabyte even with several
     * helicopters in it. This is the backstop for a defect, not a policy.
     */
    private static final int MAXIMUM_BYTES = 8 * 1024 * 1024;

    private final File file;
    private final File pending;
    private final File sharing;
    private final File sharingPending;

    HistoryStore(File filesDirectory) {
        this.file = new File(filesDirectory, FILE_NAME);
        this.pending = new File(filesDirectory, PENDING_NAME);
        this.sharing = new File(filesDirectory, SHARING_NAME);
        this.sharingPending = new File(filesDirectory, SHARING_PENDING_NAME);
        // Anything left by an interrupted write is not a history; it is the
        // tail end of one, and keeping it around is keeping flight data the
        // user was never told about.
        pending.delete();
        sharingPending.delete();
    }

    /**
     * @return the stored history, an empty string when there is none, or null
     *         when a file exists but cannot be read safely. That distinction is
     *         what prevents a transient read failure from being overwritten by
     *         the next Save as though the old history had never existed.
     */
    synchronized String read() {
        return readFrom(file, MAXIMUM_BYTES);
    }

    /**
     * Replaces the stored history.
     *
     * @return whether the new contents are on disk. False travels back to the
     *         page, which then tells the pilot the flight was not kept — the one
     *         thing worse than failing to save is saying it saved.
     */
    synchronized boolean write(String text) {
        return writeTo(file, pending, text, MAXIMUM_BYTES);
    }

    /**
     * @return the stored sharing preference and identities, an empty string
     *         when absent, or null when an existing file cannot be read.
     *         Empty means "never asked", which the page renders as sharing off
     *         and the consent question still to come — the correct state for a
     *         fresh install and for a pilot who has just erased it.
     */
    synchronized String readSharing() {
        return readFrom(sharing, MAXIMUM_SHARING_BYTES);
    }

    /** Replaces the sharing preference and identities. @return whether it landed. */
    synchronized boolean writeSharing(String text) {
        return writeTo(sharing, sharingPending, text, MAXIMUM_SHARING_BYTES);
    }

    /**
     * Deletes the sharing identity and preference, and nothing else.
     *
     * The flights survive on purpose. A pilot erasing the identity that groups
     * their shared measurements is not asking to lose the before/after history
     * they fly with, and a control that took both would be one nobody dares
     * press.
     *
     * @return true when nothing is left, including when there was nothing to
     *         start with — the caller asked for a state, not for an event.
     */
    synchronized boolean forgetSharing() {
        sharingPending.delete();
        sharing.delete();
        return !sharing.exists() && !sharingPending.exists();
    }

    /**
     * Deletes the history outright, and reports only that file's result.
     *
     * Not "write an empty history": a file containing an empty history is still
     * a file saying somebody used this feature. The page invokes
     * {@link #forgetSharing()} separately for "Forget everything" so a failure
     * deleting one file cannot make it lie about the other file's outcome.
     *
     * @return true when neither the history nor a half-written staging file
     *         remains, including when neither existed to start with — the
     *         caller asked for a state, not for an event.
     */
    synchronized boolean forget() {
        pending.delete();
        file.delete();
        return !file.exists() && !pending.exists();
    }

    // -----------------------------------------------------------------------
    // The mechanics, shared by both files
    //
    // One implementation, because the durability argument is identical for both
    // and two copies of it is how one of them ends up without the fsync.
    // -----------------------------------------------------------------------

    private static String readFrom(File source, int maximumBytes) {
        if (!source.exists()) {
            return "";
        }

        try (InputStream input = new FileInputStream(source)) {
            ByteArrayOutputStream collected = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (collected.size() + count > maximumBytes) {
                    return null;
                }
                collected.write(buffer, 0, count);
            }
            return new String(collected.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException | SecurityException unreadable) {
            // Null is a distinct bridge value, not "nothing stored". The page
            // blocks writes until the owner explicitly erases the unreadable
            // file, so a transient failure cannot silently destroy the history.
            return null;
        }
    }

    private static boolean writeTo(File target, File staging, String text, int maximumBytes) {
        if (text == null || text.length() > maximumBytes) {
            return false;
        }

        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > maximumBytes) {
            return false;
        }

        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            return false;
        }

        try (FileOutputStream output = new FileOutputStream(staging)) {
            output.write(bytes);
            output.flush();
            // Forces the bytes out of the kernel's page cache before the rename
            // is allowed to make them the history. Without it a power loss can
            // leave a renamed file whose contents never arrived.
            output.getFD().sync();
        } catch (IOException | SecurityException failed) {
            staging.delete();
            return false;
        }

        // renameTo over an existing file is atomic on the same filesystem, and
        // both of these are in getFilesDir(). Delete-then-rename would leave a
        // window with no history at all.
        if (staging.renameTo(target)) {
            return true;
        }

        // Some filesystems refuse a rename onto an existing file. Falling back
        // costs the atomicity, so it is the second attempt and not the first.
        if (target.delete() && staging.renameTo(target)) {
            return true;
        }

        staging.delete();
        return false;
    }
}
