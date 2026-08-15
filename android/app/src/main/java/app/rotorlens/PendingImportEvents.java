package app.rotorlens;

/**
 * The import events that arrived before the WebView page could hear them.
 *
 * MainActivity owns this on the UI thread. Keeping the state Android-free makes
 * the cold-start ordering and latest-selection rule executable in JVM tests.
 */
final class PendingImportEvents {

    private long generation = Long.MIN_VALUE;
    private String start;
    private String terminal;

    /** Retires every event from the previous slot and opens a new generation. */
    void retire(long nextGeneration) {
        generation = nextGeneration;
        start = null;
        terminal = null;
    }

    /** Keeps the newest provisional/metadata start event for this generation. */
    void queueStart(long eventGeneration, String script) {
        if (eventGeneration == generation) {
            start = script;
        }
    }

    /** Keeps the ready/failure event for this generation. */
    void queueTerminal(long eventGeneration, String script) {
        if (eventGeneration == generation) {
            terminal = script;
        }
    }

    /**
     * Drains current events in start-before-terminal order.
     *
     * Combining them into one script makes the ordering explicit instead of
     * relying on two asynchronous evaluateJavascript calls being scheduled in
     * the same order by every WebView implementation.
     */
    String drain(long currentGeneration) {
        if (currentGeneration != generation) {
            return null;
        }

        String queuedStart = start;
        String queuedTerminal = terminal;
        start = null;
        terminal = null;

        if (queuedStart == null) {
            return queuedTerminal;
        }
        if (queuedTerminal == null) {
            return queuedStart;
        }
        return queuedStart + ";\n" + queuedTerminal;
    }
}
