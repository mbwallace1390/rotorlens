package app.rotorlens;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** JVM coverage for the native files whose failure semantics protect user data. */
public final class HistoryStoreTest {

    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void failedOversizeWriteKeepsThePreviousHistory() throws Exception {
        HistoryStore store = new HistoryStore(temporary.newFolder("files"));
        String saved = "{\"kind\":\"rotorlens-flight-history\"}";

        assertEquals("", store.read());
        assertTrue(store.write(saved));
        assertFalse(store.write("x".repeat(8 * 1024 * 1024 + 1)));
        assertEquals(saved, store.read());
    }

    @Test
    public void historyAndSharingDeletionReportTheirOwnFilesIndependently()
            throws Exception {
        HistoryStore store = new HistoryStore(temporary.newFolder("files"));

        assertTrue(store.write("history"));
        assertTrue(store.writeSharing("sharing"));
        assertTrue(store.forgetSharing());
        assertEquals("history", store.read());
        assertEquals("", store.readSharing());

        assertTrue(store.writeSharing("sharing-again"));
        assertTrue(store.forget());
        assertEquals("", store.read());
        assertEquals("sharing-again", store.readSharing());
        assertTrue(store.forgetSharing());
        assertEquals("", store.readSharing());
    }

    @Test
    public void deletionReportsAnUndeletableStagingFile() throws Exception {
        File files = temporary.newFolder("files");
        HistoryStore store = new HistoryStore(files);

        File historyStaging = new File(files, "flight-history.writing");
        assertTrue(historyStaging.mkdir());
        assertTrue(new File(historyStaging, "still-here").createNewFile());
        assertFalse(store.forget());

        File sharingStaging = new File(files, "sharing.writing");
        assertTrue(sharingStaging.mkdir());
        assertTrue(new File(sharingStaging, "still-here").createNewFile());
        assertFalse(store.forgetSharing());
    }
}
