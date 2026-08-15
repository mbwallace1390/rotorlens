package app.rotorlens;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** JVM proof for cold-start replay ordering and latest-selection ownership. */
public final class PendingImportEventsTest {

    @Test
    public void retiringAReplaysOnlyCurrentBStartThenTerminal() {
        PendingImportEvents pending = new PendingImportEvents();
        pending.retire(10);
        pending.queueStart(10, "start-A");
        pending.queueTerminal(10, "terminal-A");

        pending.retire(11);
        pending.queueStart(10, "late-start-A");
        pending.queueTerminal(10, "late-terminal-A");
        pending.queueStart(11, "provisional-start-B");
        pending.queueStart(11, "metadata-start-B");
        pending.queueTerminal(11, "terminal-B");

        assertEquals("metadata-start-B;\nterminal-B", pending.drain(11));
        assertNull(pending.drain(11));
    }
}
