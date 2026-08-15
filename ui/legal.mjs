/**
 * The legal screen.
 *
 * Apache-2.0 section 4 obliges whoever distributes a binary to give every
 * recipient the license text and the attribution notices for what is inside it.
 * RotorLens declares one Android dependency and ships twenty-eight artifacts
 * from four copyright holders, so Android's component section is built from
 * `legal-data.mjs` — generated from the resolved classpath — rather than from a
 * list someone remembered to update. iOS and web select their own component
 * lists and therefore never claim Android Maven artifacts.
 *
 * It also carries the non-affiliation statement. Trademark is independent of
 * license: nothing here may read as though the Rotorflight or Betaflight
 * projects endorse this app.
 *
 * Rendered on first open. A user who never opens About & Legal pays nothing for it, and
 * on a phone decoding 130,000 samples that is worth the four lines it costs.
 *
 * That sentence was written before the data was fetched on demand, and until
 * 13 August 2026 it was not true: `legal-data.mjs` was a static import, so all
 * 18 KB of it — twenty-eight Maven coordinates and the 11 KB Apache text — was
 * fetched, parsed and evaluated before the page painted, for every user, on
 * every launch. `import()` in `render` is what makes the claim above accurate.
 *
 * It buys very little. Measured in headless Chromium over 15 loads, dropping
 * this module from the start-up graph moved neither DOMContentLoaded nor
 * `Performance.ScriptDuration` outside the run-to-run noise — V8 compiles
 * function bodies lazily, so a module that is mostly data and declarations
 * costs a scan rather than a compile. What it does buy is one fewer request the
 * WebView makes before the first paint, and a comment that is true. It is kept
 * because it costs one line and no clarity, not because it is fast.
 */

const $ = id => document.getElementById(id);

/**
 * Deliberately a local copy rather than an import from app.mjs.
 *
 * Everything rendered here is our own generated data, so this is defence in
 * depth rather than a live risk — but a copyright line is still text from a
 * file, and the day someone adds a component with an ampersand in its holder
 * name is not the day to discover this was interpolated raw.
 */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function componentBlock(component) {
  const note = component.note
    ? `<p class="muted" style="font-size:12.5px;margin:6px 0 0">${esc(component.note)}</p>`
    : '';

  return `<h3>${esc(component.holder)}</h3>
    <p style="margin:0 0 6px">
      <a href="${esc(component.url)}" target="_blank" rel="noreferrer noopener">${esc(component.url)}</a>
      <span class="muted"> &mdash; ${esc(component.license)}</span>
    </p>
    <p style="margin:0 0 8px">${esc(component.copyright)}</p>
    <ul class="codes">${
      component.artifacts.map(artifact => `<li><code>${esc(artifact)}</code></li>`).join('')
    }</ul>
    ${note}`;
}

const PLATFORM_LABELS = Object.freeze({android: 'Android', ios: 'iOS', web: 'Web'});
const isPlatform = value => value === 'android' || value === 'ios' || value === 'web';

/**
 * Resolves the host without guessing from the user agent.
 *
 * iOS injects `RotorLensPlatform` before document scripts run. Android cannot
 * inject a document-start variable reliably, so its synchronous JavaScript
 * bridge supplies `platform()`. A normal browser has neither and stays `web`,
 * which prevents Android Maven notices from being presented as web/iOS code.
 */
function resolvePlatform(scope = globalThis) {
  const explicit = scope.RotorLensPlatform;
  if (isPlatform(explicit)) {
    return explicit;
  }

  try {
    const nativePlatform = scope.RotorLensNative?.platform?.();
    if (isPlatform(nativePlatform)) {
      return nativePlatform;
    }
  } catch {
    // A bridge failure must not make a web or iOS build claim Android contents.
  }

  return 'web';
}

function draw(LEGAL, platform = resolvePlatform()) {
  const container = $('legal');
  const components = LEGAL.componentsByPlatform[platform] ?? [];
  const shipped = components.reduce((total, entry) => total + entry.artifacts.length, 0);
  const componentLicenses = new Set(components.map(component => component.license));
  const componentMarkup = shipped > 0
    ? `<p class="muted" style="font-size:12.5px;margin:0 0 4px">
        Everything this platform build carries, resolved from its build rather than declared by hand.
      </p>
      ${components.map(componentBlock).join('')}`
    : `<p class="muted" id="legal-no-platform-components" style="font-size:12.5px;margin:0">
        No platform-specific third-party components are recorded for this ${esc(PLATFORM_LABELS[platform])} build.
      </p>`;
  const apacheMarkup = componentLicenses.has('Apache-2.0')
    ? `<h3>Apache License 2.0</h3>
      <p class="muted" style="font-size:12.5px;margin:0 0 8px">
        Applies to the Apache-2.0 components listed above.
      </p>
      <pre class="license" id="legal-apache"></pre>`
    : '';

  container.innerHTML = `
    <h3 style="margin-top:0">${esc(LEGAL.project.name)}</h3>
    <p style="margin:0 0 6px"><b>${esc(LEGAL.project.attribution)}</b></p>
    <p style="margin:0 0 6px">${esc(LEGAL.project.copyright)} &mdash;
      ${esc(LEGAL.project.license)}</p>
    <p class="muted" style="font-size:12.5px;margin:0 0 4px">
      Source:
      <a id="legal-source" href="${esc(LEGAL.project.sourceUrl)}" target="_blank"
         rel="noreferrer noopener">${esc(LEGAL.project.sourceLabel)}</a>
    </p>
    <p class="muted" id="legal-source-status" style="font-size:12.5px;margin:0 0 4px">
      ${esc(LEGAL.project.sourceStatus)}
    </p>
    <p class="muted" style="font-size:12.5px;margin:0 0 14px">
      Official repository:
      <a id="legal-repository" href="${esc(LEGAL.project.repository)}" target="_blank"
         rel="noreferrer noopener">${esc(LEGAL.project.repository)}</a>
    </p>

    <h3 style="margin-top:0">${esc(LEGAL.disclaimer.title)}</h3>
    ${LEGAL.disclaimer.sections.map(section => `
      <p style="margin:0 0 4px"><b>${esc(section.heading)}</b></p>
      <p class="muted" style="margin:0 0 12px">${esc(section.body)}</p>
    `).join('')}

    <p class="privacy" style="text-align:left;margin-top:0">${esc(LEGAL.nonAffiliation)}</p>

    <h3>Blackbox decoder</h3>
    <p style="margin:0 0 6px">${esc(LEGAL.engine.copyright)} &mdash; ${esc(LEGAL.engine.license)}</p>
    <p class="muted" style="font-size:12.5px;margin:0">
      The Blackbox decoder in <code>${esc(LEGAL.engine.location)}</code> is RotorLens' own,
      written from the published log format. No third-party decoder is bundled.
    </p>

    <h3>Mozilla Public License 2.0</h3>
    <p class="muted" style="font-size:12.5px;margin:0 0 8px">
      Applies to RotorLens-authored source. Covered source and modifications are
      available from the source link above.
    </p>
    <pre class="license" id="legal-mpl"></pre>

    <h3>Bundled components &mdash; ${esc(PLATFORM_LABELS[platform])} (${shipped})</h3>
    ${componentMarkup}
    ${apacheMarkup}
  `;

  // textContent, not innerHTML: the licences are plain text whose exact wording
  // is the obligation. Nothing in either should be parsed as markup.
  $('legal-mpl').textContent = LEGAL.licenseTexts['MPL-2.0'];
  if ($('legal-apache')) {
    $('legal-apache').textContent = LEGAL.licenseTexts['Apache-2.0'];
  }
}

/**
 * Resolved once the notices are on screen; null while nothing is in flight.
 *
 * Two variables rather than one boolean because a fetch takes time a tap does
 * not: without `pending`, a second tap during the first load starts a second
 * fetch, and the slower of the two wins the container.
 */
let shown = false;
let pending = null;

/**
 * Puts the notices on the About & Legal page, fetching them the first time.
 *
 * Never rejects. An attribution screen that fails silently is the one failure
 * this file exists to prevent — Apache-2.0 section 4 is not satisfied by a
 * panel that opened and stayed blank — so a load failure is written into the
 * panel where the reader is already looking, and the state is reset so that
 * closing and reopening tries again.
 *
 * @returns {Promise<boolean>} whether the notices are on screen
 */
function render() {
  if (shown) {
    return Promise.resolve(true);
  }
  if (pending) {
    return pending;
  }

  const container = $('legal');
  container.innerHTML = '<p class="muted">Loading the licence notices…</p>';

  // A literal, relative specifier. The bundler-free build has no rewriting
  // step, so this exact path is what AssetServer is asked for in the APK, what
  // tools/serve-ui.mjs serves in a browser, and what Node resolves on disk. A
  // path built at runtime would be none of those, and would break the promise
  // that nothing outside the bundle is reachable.
  pending = import('./legal-data.mjs')
    .then(({LEGAL}) => {
      draw(LEGAL);
      shown = true;
      return true;
    })
    .catch(error => {
      container.innerHTML =
        `<p class="error">The licence notices could not be loaded: ${esc(error.message)}</p>` +
        `<p class="muted" style="font-size:12.5px">Leave this page and open it again to ` +
        `retry. The same notices ship in THIRD_PARTY_NOTICES.md alongside the app.</p>`;
      return false;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

const toggle = $('legal-toggle');
const page = $('legal-panel');
const back = $('legal-back');
const mainHeader = document.querySelector('body > header');
const main = document.querySelector('body > main');

let mainScrollY = 0;
let returnFocus = null;

function isLegalPageOpen() {
  return !page.classList.contains('hidden');
}

/**
 * Keeps the analysis page out of both the pointer and accessibility trees while
 * the legal page covers it. The log remains decoded in memory; this changes
 * reachability, not state.
 */
function setMainInert(inert) {
  for (const element of [mainHeader, main]) {
    if (!element) {
      continue;
    }
    element.toggleAttribute('inert', inert);
    if (inert) {
      element.setAttribute('aria-hidden', 'true');
    } else {
      element.removeAttribute('aria-hidden');
    }
  }
}

function focusableLegalControls() {
  return [...page.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), '
      + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(element => element.getClientRects().length > 0);
}

function openLegalPage() {
  if (isLegalPageOpen()) {
    return false;
  }

  mainScrollY = globalThis.scrollY;
  returnFocus = document.activeElement;
  page.classList.remove('hidden');
  page.setAttribute('aria-hidden', 'false');
  page.scrollTop = 0;
  document.body.classList.add('legal-page-open');
  toggle.setAttribute('aria-expanded', 'true');
  setMainInert(true);

  // Not awaited: the dedicated page opens on the tap that asked for it and
  // fills in when the bundled data arrives. Holding the page behind a fetch is
  // how a working control comes to look dead.
  render();
  requestAnimationFrame(() => back.focus({preventScroll: true}));
  return true;
}

function closeLegalPage() {
  if (!isLegalPageOpen()) {
    return false;
  }

  page.classList.add('hidden');
  page.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('legal-page-open');
  toggle.setAttribute('aria-expanded', 'false');
  // A future caller may open another top layer while this one is visible. Do
  // not tear down that layer's inert boundary or move focus behind it merely
  // because About & Legal is closing. The current consent gate also refuses to
  // open during this page; this is defence against later composition drift.
  const consent = $('consent');
  const consentOpen = consent && !consent.classList.contains('hidden');
  if (!consentOpen) {
    setMainInert(false);
  }
  globalThis.scrollTo({left: 0, top: mainScrollY, behavior: 'auto'});

  const target = consentOpen
    ? consent.querySelector('button:not([disabled])')
    : (returnFocus?.isConnected ? returnFocus : toggle);
  returnFocus = null;
  target?.focus({preventScroll: true});
  return true;
}

toggle.addEventListener('click', () => {
  openLegalPage();
});

back.addEventListener('click', closeLegalPage);

document.addEventListener('keydown', event => {
  if (!isLegalPageOpen()) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeLegalPage();
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  // The consent dialog owns its own Escape/Tab listener. Capture and stop the
  // event here so a topmost legal page cannot accidentally answer a consent
  // prompt that a future regression opened underneath it.
  event.stopImmediatePropagation();

  const focusable = focusableLegalControls();
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

Object.defineProperty(globalThis, 'RotorLensIsLegalPageOpen', {
  value: isLegalPageOpen,
  writable: false,
  configurable: false,
  enumerable: false
});

// Android asks this hook before navigating or finishing the Activity. Wrap the
// app's existing consent handler rather than replacing it: system Back closes
// the topmost in-app page first, then preserves the older dialog behaviour.
const previousHandleBack = globalThis.RotorLensHandleBack;
globalThis.RotorLensHandleBack = () => {
  if (closeLegalPage()) {
    return true;
  }
  return typeof previousHandleBack === 'function' ? previousHandleBack() : false;
};

export {closeLegalPage, isLegalPageOpen, openLegalPage, render, resolvePlatform};
