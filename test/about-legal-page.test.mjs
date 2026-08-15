import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('ui/index.html', root), 'utf8');
const script = await readFile(new URL('ui/legal.mjs', root), 'utf8');

test('About & Legal is a dedicated full-screen in-app page', () => {
  const mainEnd = html.indexOf('</main>');
  const legalPage = html.indexOf('id="legal-panel"');

  assert.ok(mainEnd >= 0 && legalPage > mainEnd,
    'the legal view must live outside the analysis main so it consumes no main-page space');
  assert.match(html,
    /id="legal-toggle"[^>]*aria-controls="legal-panel"[^>]*>About &amp; Legal<\/button>/);
  assert.match(html,
    /class="legal-page hidden" id="legal-panel" role="dialog" aria-modal="true"[\s\S]*aria-hidden="true"/);
  assert.match(html, /id="legal-back"[^>]*aria-label="Back to RotorLens"/);
  assert.match(html,
    /\.legal-page\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(html, /padding:\s*calc\(12px \+ env\(safe-area-inset-top\)\)/,
    'the dedicated page chrome must clear an iPhone notch and Android status bar');
  assert.doesNotMatch(html.slice(0, mainEnd), /id="legal-panel"/,
    'licence content must not return to the main analysis layout');
});

test('the legal page preserves analysis state and has complete local back behavior', () => {
  assert.match(script, /function openLegalPage\(\)/);
  assert.match(script, /function closeLegalPage\(\)/);
  assert.match(script, /document\.body\.classList\.add\('legal-page-open'\)/);
  assert.match(script, /element\.toggleAttribute\('inert', inert\)/,
    'the covered analysis controls must leave the accessibility and pointer trees');
  assert.match(script, /returnFocus = document\.activeElement/);
  assert.match(script, /globalThis\.scrollTo\(\{left: 0, top: mainScrollY/);
  assert.match(script, /event\.key === 'Escape'/);
  assert.match(script, /event\.stopImmediatePropagation\(\)/,
    'the topmost page must own Escape and Tab before an underlying modal can act');
  assert.match(script, /Object\.defineProperty\(globalThis, 'RotorLensIsLegalPageOpen'/,
    'other top layers need a stable way to defer while About & Legal is open');
  assert.match(script, /if \(!consentOpen\) \{\s*setMainInert\(false\);/,
    'closing About must not clear another visible modal\'s inert boundary');
  assert.match(script, /const previousHandleBack = globalThis\.RotorLensHandleBack/);
  assert.match(script, /globalThis\.RotorLensHandleBack = \(\) => \{/);
  assert.match(script, /if \(closeLegalPage\(\)\) \{\s*return true;/);
  assert.match(script, /import\('\.\/legal-data\.mjs'\)/,
    'the long licence bundle must remain lazy until the page is opened');
  assert.doesNotMatch(script, /scrollIntoView/,
    'opening the legal view must not move or discard the analysis page scroll position');
});
