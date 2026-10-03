package app.rotorlens;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * The copy a provider can break, driven through ImportStore.accept itself.
 *
 * The import runs on a bare thread with no uncaught-exception handler, so any
 * exception that escapes accept() kills the whole app. A provider is another
 * app's code: FileProvider throws IllegalArgumentException for a path outside its
 * configured roots, and cloud document providers throw IllegalStateException or
 * UnsupportedOperationException for stale and virtual documents, across the
 * binder, as unchecked exceptions.
 */
public final class ImportStoreTest {

    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    /** A stream that hands over some bytes and then fails the way a provider can. */
    private static InputStream failingAfter(int bytes, RuntimeException failure) {
        return new InputStream() {
            private int served;

            @Override
            public int read() {
                if (served >= bytes) {
                    throw failure;
                }
                served++;
                return 'x';
            }

            @Override
            public int read(byte[] buffer, int offset, int length) {
                if (served >= bytes) {
                    throw failure;
                }
                int count = Math.min(length, bytes - served);
                for (int index = 0; index < count; index++) {
                    buffer[offset + index] = 'x';
                }
                served += count;
                return count;
            }
        };
    }

    private static void assertNoImportLeftIn(File cache) {
        File[] left = new File(cache, "imports").listFiles();
        assertTrue("a failed copy must not leave flight data in the cache",
                left == null || left.length == 0);
    }

    @Test
    public void providerThatThrowsUncheckedOnOpenReportsUnreadable() throws Exception {
        File cache = temporary.newFolder("cache");
        ImportStore store = new ImportStore(cache);

        ImportStore.Result result = store.accept(() -> {
            throw new IllegalArgumentException("Failed to find configured root");
        }, "LOG00012.bbl", () -> true, null);

        assertFalse(result.ready);
        assertEquals("unreadable", result.reason);
        assertNoImportLeftIn(cache);
    }

    @Test
    public void providerThatThrowsUncheckedMidCopyReportsUnreadable() throws Exception {
        File cache = temporary.newFolder("cache");
        ImportStore store = new ImportStore(cache);

        ImportStore.Result result = store.accept(
                () -> failingAfter(200 * 1024, new IllegalStateException("document went stale")),
                "LOG00012.bbl", () -> true, null);

        assertFalse(result.ready);
        assertEquals("unreadable", result.reason);
        assertNoImportLeftIn(cache);
    }

    @Test
    public void uncheckedFailureAfterReplacementIsACancellationNotAnError() throws Exception {
        File cache = temporary.newFolder("cache");
        ImportStore store = new ImportStore(cache);
        boolean[] current = {true};

        ImportStore.Result result = store.accept(() -> new InputStream() {
            @Override
            public int read() {
                // A newer selection retired this one while the provider was busy.
                current[0] = false;
                throw new UnsupportedOperationException("virtual document");
            }
        }, "old.bbl", () -> current[0], null);

        assertFalse(result.ready);
        assertEquals("cancelled", result.reason);
        assertNoImportLeftIn(cache);
    }

    @Test
    public void checkedFailuresKeepTheirExistingMeaning() throws Exception {
        File cache = temporary.newFolder("cache");
        ImportStore store = new ImportStore(cache);

        ImportStore.Result missing = store.accept(() -> {
            throw new java.io.FileNotFoundException("gone");
        }, "gone.bbl", () -> true, null);
        assertEquals("unreadable", missing.reason);

        ImportStore.Result revoked = store.accept(() -> {
            throw new SecurityException("grant expired");
        }, "revoked.bbl", () -> true, null);
        assertEquals("unreadable", revoked.reason);
        assertNoImportLeftIn(cache);
    }

    @Test
    public void aHealthyProviderStillCommitsTheWholeLog() throws Exception {
        File cache = temporary.newFolder("cache");
        ImportStore store = new ImportStore(cache);
        byte[] log = new byte[300 * 1024];
        for (int index = 0; index < log.length; index++) {
            log[index] = (byte) index;
        }

        ImportStore.Result result = store.accept(
                () -> new ByteArrayInputStream(log), "LOG00012.bak.bbl", () -> true, null);

        assertTrue(result.ready);
        assertEquals(log.length, result.byteLength);
        assertEquals("LOG00012.bak.bbl", result.displayName);
        File committed = store.current(result.id);
        assertNotNull(committed);
        assertEquals(log.length, committed.length());
    }

    @Test(expected = OutOfMemoryError.class)
    public void anErrorIsNotSwallowed() throws Exception {
        // Only exceptions are a provider's to throw. An Error is this process
        // failing, and hiding it behind "unreadable" would report a broken app as
        // a bad file.
        File cache = temporary.newFolder("cache");
        new ImportStore(cache).accept(() -> {
            throw new OutOfMemoryError("not a provider failure");
        }, "x.bbl", () -> true, null);
    }
}
