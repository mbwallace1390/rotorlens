package app.rotorlens;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Pure JVM checks for the identity/name pairing handed across the WebView bridge. */
public final class ImportContractTest {

    @Test
    public void committedResultKeepsItsOwnPathNameAndSizeTogether() {
        ImportStore.Result result = ImportStore.Result.ready(27, "second.LOG", 8192);

        assertTrue(result.ready);
        assertEquals(27, result.id);
        assertEquals("/import/27", AssetServer.importPath(result.id));
        assertEquals("second.LOG", result.displayName);
        assertEquals(8192, result.byteLength);
        assertNull(result.reason);
    }

    @Test
    public void failedResultCannotMasqueradeAsACommittedImport() {
        ImportStore.Result result = ImportStore.Result.failed("cancelled");

        assertFalse(result.ready);
        assertEquals(-1, result.id);
        assertEquals(0, result.byteLength);
        assertEquals("cancelled", result.reason);
        assertNull(result.displayName);
    }
}
