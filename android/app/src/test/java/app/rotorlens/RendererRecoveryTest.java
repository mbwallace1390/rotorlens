package app.rotorlens;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * When a dead WebView renderer is replaced, and when replacing it would loop.
 *
 * The shell never re-offers the log that was open when the renderer died, so a
 * big log cannot kill the replacement. What is left to guard is a renderer that
 * dies on its own before any page loads — a broken WebView update, say — where
 * rebuilding forever would be a crash loop with extra steps.
 */
public final class RendererRecoveryTest {

    @Test
    public void aRendererLostAfterThePageLoadedIsReplaced() {
        RendererRecovery recovery = new RendererRecovery();
        recovery.pageLoaded();

        assertTrue(recovery.mayRebuildAfterLoss());
    }

    @Test
    public void aRendererLostBeforeAnyPageLoadedGetsOneReplacement() {
        RendererRecovery recovery = new RendererRecovery();

        assertTrue("the first loss is always worth one retry", recovery.mayRebuildAfterLoss());
        assertFalse("the replacement died before its page loaded: that is a loop",
                recovery.mayRebuildAfterLoss());
        assertFalse("and it stays refused", recovery.mayRebuildAfterLoss());
    }

    @Test
    public void aReplacementThatLoadedEarnsAnotherRecovery() {
        RendererRecovery recovery = new RendererRecovery();
        recovery.pageLoaded();

        // The pilot opens a log too big for this phone, the renderer dies, the
        // page comes back and says so, and the pilot tries the same log again.
        // Every loss here followed a page that loaded, so each one is a new
        // event the pilot caused rather than a loop.
        for (int attempt = 0; attempt < 5; attempt++) {
            assertTrue(recovery.mayRebuildAfterLoss());
            recovery.pageLoaded();
        }
    }

    @Test
    public void lossesBetweenLoadsAreCountedFromTheLastLoad() {
        RendererRecovery recovery = new RendererRecovery();
        recovery.pageLoaded();

        assertTrue(recovery.mayRebuildAfterLoss());
        assertFalse(recovery.mayRebuildAfterLoss());
        recovery.pageLoaded();
        assertTrue(recovery.mayRebuildAfterLoss());
    }
}
