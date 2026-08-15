/**
 * The boundary between the viewer and whatever is hosting it.
 *
 * In a browser the host is the file input and drag-and-drop. On Android it is a
 * native shell that receives share intents, handles the system file picker, and
 * hands the bytes back. Both arrive here as the same thing — a name and a
 * promise of bytes — so nothing downstream knows or cares which it is.
 *
 * The native side is kept deliberately thin. Anything implemented in Java is
 * something that cannot be tested in this repository's test suite, so the native
 * shell transports a session-only import and exposes two small private stores;
 * all decoding, analysis, and storage policy stay in the tested page code.
 *
 * ## Contract with the native shell
 *
 * Native → page: dispatch `rotorlens-file` on `window` with
 *   `detail: {name: string, url: string, size: number}` where `url` serves the
 *   raw bytes and `size` is checked before allocating the response body.
 *
 * Native → page: dispatch `rotorlens-import-failed` on `window` with
 *   `detail: {name: string, reason: string}` when a file was offered and could
 *   not be taken. Without this the user picks a file, the picker closes, and
 *   nothing on screen changes — indistinguishable from the app being frozen.
 *
 * Native → page: dispatch `rotorlens-import-started` with
 *   `detail: {name: string, total: number, generation: number}` when a copy
 *   begins, then `rotorlens-import-progress` with
 *   `detail: {copied: number, total: number, generation: number}` as it runs.
 *   Generation binds progress to the newest selection. `total` is -1 when the
 *   provider would not say how big the file is — a normal outcome, not an
 *   error. Reading a full dataflash takes over two minutes, and until these
 *   existed the screen did not change for any of it.
 *
 * Page → native: `window.RotorLensNative.pickFile()` opens the system picker.
 *   Its absence means we are in a browser and the file input should be used.
 *
 * Page → native: Android also exposes `platform()` returning `"android"` so
 *   About & Legal renders only the dependencies that APK actually carries.
 *   The iOS shell injects the immutable `window.RotorLensPlatform = "ios"`
 *   marker before document scripts run; an ordinary browser defaults to `web`.
 *
 * Page → native: `readHistory()`, `writeHistory(text)`, `forgetHistory()` own
 *   the flight history file. A shell may return either the value itself (the
 *   Android JavaScript interface) or a Promise for it (the iOS WebKit reply
 *   bridge). Every adapter below awaits `Promise.resolve(...)`, so the page has
 *   one asynchronous contract without making Android pretend its bridge is
 *   asynchronous. See `hasHistoryStore` for why this is a native file and not
 *   browser storage.
 *
 * Page → native: `readSharing()`, `writeSharing(text)`, `forgetSharing()` own a
 *   second, much smaller file beside it, holding a sharing preference and one
 *   random identity per helicopter. Each forget call reports only its own file;
 *   the page calls both for “Forget everything” so a partial failure is shown
 *   truthfully. Nothing in this build sends anything anywhere — see the section
 *   on it below.
 *
 * Bytes travel by URL rather than as a string. An 8 MB log base64-encoded into a
 * JavaScript call is an 11 MB string built and parsed on the UI thread; a fetch
 * from the shell's own asset origin is neither.
 *
 * ## `bytes()` is called once, and the result is now kept
 *
 * Since 13 August 2026 the viewer decodes one session at a time, which means the
 * decoder reads the file ON DEMAND and the array `bytes()` returned stays
 * reachable for as long as that log is open — 125 MiB for a full dataflash dump.
 * That is a real cost and it is new; it is also far below what decoding every
 * session cost, and `ui/app.mjs` drops the previous log before reading the next
 * one so only ever one file is resident.
 *
 * BOTH sources here can be read again — a `File` is backed by the picked file
 * and a host URL is served by the shell — so a future version could hand the
 * decoder a reader instead of a buffer and stop holding the file at all. Nothing
 * in this module has to change for that; it is `openFile` that keeps the array.
 */

export const HOST_FILE_EVENT = 'rotorlens-file';
export const HOST_FILE_FAILED_EVENT = 'rotorlens-import-failed';
export const HOST_IMPORT_STARTED_EVENT = 'rotorlens-import-started';
export const HOST_IMPORT_PROGRESS_EVENT = 'rotorlens-import-progress';

// The decoder currently needs one contiguous Uint8Array. This ceiling matches
// the largest dataflash image the lazy-session design is exercised against and
// prevents an oversized document from forcing an allocation the WebView cannot
// possibly keep alongside its canvases and one decoded session.
export const MAXIMUM_FILE_BYTES = 128 * 1024 * 1024;

function abortError() {
  const error = new Error('The file read was replaced by a newer selection');
  error.name = 'AbortError';
  return error;
}

/** True when a native shell is hosting the page. */
export function hasNativeHost(scope = globalThis) {
  return Boolean(scope.RotorLensNative && typeof scope.RotorLensNative.pickFile === 'function');
}

/**
 * Asks the host to open a file.
 *
 * Native shells own their own picker so the system UI matches the platform;
 * in a browser this falls back to clicking the hidden file input.
 */
export function requestFile(scope = globalThis, fallback) {
  if (hasNativeHost(scope)) {
    scope.RotorLensNative.pickFile();
    return 'native';
  }
  if (typeof fallback === 'function') {
    fallback();
  }
  return 'browser';
}

/**
 * Normalizes anything the host can hand us into `{name, bytes()}`.
 *
 * `bytes()` is deliberately lazy: a share intent may arrive before the page is
 * ready to decode, and reading an 8 MB log is not something to do twice.
 */
export function fromFile(file) {
  return {
    name: file.name,
    bytes: (signal = null) => new Promise((resolve, reject) => {
      if (Number.isFinite(file.size) && file.size > MAXIMUM_FILE_BYTES) {
        reject(new RangeError('This log is larger than the 128 MiB safe limit'));
        return;
      }
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      const reader = new FileReader();
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const abort = () => {
        reader.abort();
        cleanup();
        reject(abortError());
      };
      signal?.addEventListener('abort', abort, {once: true});
      reader.onload = () => {
        cleanup();
        const bytes = new Uint8Array(reader.result);
        if (bytes.length > MAXIMUM_FILE_BYTES) {
          reject(new RangeError('This log is larger than the 128 MiB safe limit'));
        } else {
          resolve(bytes);
        }
      };
      reader.onerror = () => {
        cleanup();
        reject(reader.error ?? new Error('Could not read the file'));
      };
      reader.onabort = () => {
        cleanup();
        reject(abortError());
      };
      reader.readAsArrayBuffer(file);
    })
  };
}

export function fromHostEvent(detail, scope = globalThis) {
  const declaredSize = Number(detail.size);
  return {
    name: detail.name,
    bytes: async (signal = null) => {
      if (Number.isFinite(declaredSize) && declaredSize > MAXIMUM_FILE_BYTES) {
        throw new RangeError('This log is larger than the 128 MiB safe limit');
      }
      const response = await scope.fetch(detail.url, {signal});
      if (!response.ok) {
        throw new Error(`The app could not read the imported file (${response.status})`);
      }
      const headerSize = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(headerSize) && headerSize > MAXIMUM_FILE_BYTES) {
        throw new RangeError('This log is larger than the 128 MiB safe limit');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAXIMUM_FILE_BYTES) {
        throw new RangeError('This log is larger than the 128 MiB safe limit');
      }
      return bytes;
    }
  };
}

/**
 * Subscribes to files delivered by a native host.
 *
 * Returns an unsubscribe function so the listener can be torn down in tests
 * without leaking between them.
 */
export function onHostFile(handler, scope = globalThis) {
  const listener = event => {
    const detail = event?.detail;
    if (detail && typeof detail.name === 'string' && typeof detail.url === 'string') {
      handler(fromHostEvent(detail, scope));
    }
  };

  scope.addEventListener(HOST_FILE_EVENT, listener);
  return () => scope.removeEventListener(HOST_FILE_EVENT, listener);
}

/**
 * Subscribes to imports the host could not complete.
 *
 * `reason` is a stable code, not prose: 'no-file' when a share carried text
 * rather than a file, 'unreadable' when the copy itself failed, and 'too-large'
 * when it exceeds the bounded reader. The wording belongs here, where it can
 * change without touching Java.
 */
export function onHostFileFailed(handler, scope = globalThis) {
  const listener = event => {
    const detail = event?.detail;
    if (detail && typeof detail.name === 'string') {
      handler({
        name: detail.name,
        reason: typeof detail.reason === 'string' ? detail.reason : 'unreadable'
      });
    }
  };

  scope.addEventListener(HOST_FILE_FAILED_EVENT, listener);
  return () => scope.removeEventListener(HOST_FILE_FAILED_EVENT, listener);
}

// ---------------------------------------------------------------------------
// Import progress
// ---------------------------------------------------------------------------

/**
 * Numbers off the bridge, coerced rather than trusted.
 *
 * The detail is built by string concatenation in Java, so a field can arrive
 * as a string, as `null`, or not at all. `total` has one meaningful special
 * value — -1, "the provider would not say" — and every other non-finite value
 * is treated the same way, because a progress bar that computes a percentage
 * from `undefined` shows NaN% to somebody watching a two-minute copy.
 */
function count(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
}

/** Subscribes to "a copy has begun". Returns an unsubscribe function. */
export function onHostImportStarted(handler, scope = globalThis) {
  const listener = event => {
    const detail = event?.detail;
    if (detail) {
      handler({
        name: typeof detail.name === 'string' ? detail.name : 'log',
        total: count(detail.total),
        generation: count(detail.generation)
      });
    }
  };

  scope.addEventListener(HOST_IMPORT_STARTED_EVENT, listener);
  return () => scope.removeEventListener(HOST_IMPORT_STARTED_EVENT, listener);
}

/** Subscribes to copy progress. Throttled to one event per 200 ms by the shell. */
export function onHostImportProgress(handler, scope = globalThis) {
  const listener = event => {
    const detail = event?.detail;
    if (detail) {
      handler({
        copied: count(detail.copied),
        total: count(detail.total),
        generation: count(detail.generation)
      });
    }
  };

  scope.addEventListener(HOST_IMPORT_PROGRESS_EVENT, listener);
  return () => scope.removeEventListener(HOST_IMPORT_PROGRESS_EVENT, listener);
}

// ---------------------------------------------------------------------------
// The flight history file
// ---------------------------------------------------------------------------

/**
 * True when the host can keep a flight history between sessions.
 *
 * ## Why this is a native file and not browser storage
 *
 * The history is one of the two small files RotorLens keeps after the app closes
 * (the other is the sharing preference and identities below), so where it lives
 * is a privacy decision rather than a convenience one:
 *
 *  - `docs/PRIVACY_POLICY.md` promises "no browser storage of any kind — no
 *    localStorage, no IndexedDB, no web databases", and
 *    `test/privacy-claims.test.mjs` enforces that by refusing to let those words
 *    appear in anything that ships. Using one would make a shipped policy false.
 *  - Android keeps the files in `getFilesDir()`, disables cloud backup with
 *    `android:allowBackup="false"`, and excludes phone-to-phone migration with
 *    `android:dataExtractionRules`. iOS keeps separate files in Application
 *    Support and marks both their directory and committed paths as excluded from
 *    backup; that Apple resource value is guidance that still needs device
 *    backup and migration proof before release. Both stores survive an update
 *    and are removed with the app's data. WebView storage is instead a cache the
 *    system may clear and a directory the user cannot find.
 *  - It keeps the guarantee checkable: history and sharing use separate fixed
 *    files, each written through one narrow bridge method, and `exportHistory`
 *    is the only thing that can produce a history record.
 *
 * In a plain browser there is no host, so nothing is stored at all — which is
 * the honest behaviour for a viewer that promised not to store anything without
 * somewhere it can defend keeping it.
 */
export function hasHistoryStore(scope = globalThis) {
  const native = scope.RotorLensNative;
  return Boolean(native
    && typeof native.readHistory === 'function'
    && typeof native.writeHistory === 'function');
}

/**
 * Reads the history file back. Empty string means no file; null means either no
 * host or that the host could not safely read an existing file. Callers that
 * have a host must treat null as a write-blocking error, not as empty history.
 *
 * Returns a Promise and never rejects. This runs during start-up, and a bridge that raised here would
 * take the whole page down before a single panel had rendered — a blank screen
 * for a pilot standing at a flying field, in exchange for a feature they may not
 * even be using.
 */
export async function readHistoryText(scope = globalThis) {
  if (!hasHistoryStore(scope)) {
    return null;
  }
  try {
    const text = await Promise.resolve(scope.RotorLensNative.readHistory());
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** Writes the history file. Resolves to whether the host says it landed. */
export async function writeHistoryText(text, scope = globalThis) {
  if (!hasHistoryStore(scope) || typeof text !== 'string') {
    return false;
  }
  try {
    return await Promise.resolve(scope.RotorLensNative.writeHistory(text)) === true;
  } catch {
    return false;
  }
}

/**
 * Deletes the history file outright.
 *
 * Separate from writing an empty history on purpose: "forget everything" must
 * leave nothing behind, and a file containing an empty history is still a file
 * that says somebody once used this feature.
 *
 * Resolves with only the history file's result. The caller erases sharing separately so
 * either unlink can fail without obscuring the result of the other one.
 */
export async function forgetHistoryFile(scope = globalThis) {
  if (!hasHistoryStore(scope)) {
    return false;
  }
  try {
    const native = scope.RotorLensNative;
    const result = typeof native.forgetHistory === 'function'
      ? native.forgetHistory()
      : native.writeHistory('');
    return await Promise.resolve(result) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The sharing preference, and the identity that would carry it
//
// A second small file beside the history, holding a choice and one random value
// per helicopter. It exists so that the consent, the identity and the deletion
// path are built and provable BEFORE anything can be sent — the owner's point,
// and the right one: retrofitting network access onto an installed base is worse
// than shipping with it.
//
// NOTHING IN THIS APP SENDS ANYTHING ANYWHERE. There is no transport in this
// build. Android's missing INTERNET permission is an additional OS barrier;
// iOS has no equivalent permission, so its guarantee comes from the absence of
// transport code. The preference records a choice; no code acts on it. Adding
// transport is a separate, deliberate change that also rewrites the store
// listing, privacy policy and the tests that pin them — see
// docs/SHARED_CORPUS_DESIGN.md §7.
// ---------------------------------------------------------------------------

/**
 * True when the host can keep a sharing preference between sessions.
 *
 * Checked separately from `hasHistoryStore` rather than assumed from it: an
 * older shell built before this feature existed installs a bridge with the
 * history methods and not these, and asking somebody a consent question whose
 * answer cannot be written down is worse than not asking.
 */
export function hasSharingStore(scope = globalThis) {
  const native = scope.RotorLensNative;
  return Boolean(native
    && typeof native.readSharing === 'function'
    && typeof native.writeSharing === 'function');
}

/** Reads sharing, resolving to null when absent/unreadable. Never rejects. */
export async function readSharingText(scope = globalThis) {
  if (!hasSharingStore(scope)) {
    return null;
  }
  try {
    const text = await Promise.resolve(scope.RotorLensNative.readSharing());
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** Writes the sharing file. Resolves to whether the host says it landed. */
export async function writeSharingText(text, scope = globalThis) {
  if (!hasSharingStore(scope) || typeof text !== 'string') {
    return false;
  }
  try {
    return await Promise.resolve(scope.RotorLensNative.writeSharing(text)) === true;
  } catch {
    return false;
  }
}

/**
 * Deletes the sharing file, leaving the flight history alone.
 *
 * Resolves with only this file's result. The two erasures are genuinely different asks. "Erase the sharing identity"
 * must not cost a pilot the before/after history they fly with, or it becomes a
 * control nobody dares press — and a privacy control nobody presses is the same
 * as one that does not work.
 */
export async function forgetSharingFile(scope = globalThis) {
  if (!hasSharingStore(scope)) {
    return false;
  }
  try {
    const native = scope.RotorLensNative;
    const result = typeof native.forgetSharing === 'function'
      ? native.forgetSharing()
      : native.writeSharing('');
    return await Promise.resolve(result) === true;
  } catch {
    return false;
  }
}
