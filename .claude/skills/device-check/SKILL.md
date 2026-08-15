---
name: device-check
description: Drive the installed RotorLens Android app on a real handset and report what is actually on screen — panels, canvases, layout at 384px, touch targets, page errors, and the native import events. Use whenever a change touches ui/ or android/, or when a claim about phone behaviour needs verifying rather than assuming.
---

# Checking RotorLens on the phone

Types and unit tests cannot tell you whether a bar was drawn, whether a tap
lands, or whether a panel fits. Everything this project knows about its own
phone behaviour was learned by attaching to the debug WebView and asking it.

This is the procedure that works. It has been used successfully many times; the
variations that do **not** work are recorded at the bottom so nobody rediscovers
them.

## Two rules that are not negotiable

**Never a blind tap.** Every interaction is an element id the page resolves
itself — `document.getElementById(id).click()`. Never a coordinate. A blind tap
on this app would silently delete a flight history, and on another project one
logged out the wrong family member.

**Read the element you mean, then read the others too.** "The app shows nothing
during the copy" was reported to the owner twice, from querying `#status` while
the progress bar was rendering correctly into `#import-progress-label`. Dump
every panel by id before drawing a conclusion about what is or is not on screen.

## Getting attached

Build, install, launch, forward, then take the WebSocket URL. Run this from
PowerShell — the adb steps are reliable there and are not reliable from Node
(see the bottom of this file).

```powershell
$adb = if ($env:ANDROID_SDK_ROOT) {
  Join-Path $env:ANDROID_SDK_ROOT "platform-tools\adb.exe"
} else {
  "adb"
}
$device = $env:ROTORLENS_ADB_DEVICE # USB serial or an already-authorized host:port
if ([string]::IsNullOrWhiteSpace($device)) {
  throw "Set ROTORLENS_ADB_DEVICE from the output of: adb devices"
}
if ($device.Contains(":")) {
  & $adb connect $device
}

# rebuild and install after any ui/ or android/ change
Set-Location .\android
.\gradlew assembleDebug -q
& $adb -s $device install -r app\build\outputs\apk\debug\app-debug.apk

# forward the devtools socket for the RUNNING process
$p = (& $adb -s $device shell pidof app.rotorlens).Trim()
& $adb -s $device forward --remove-all
& $adb -s $device forward tcp:9223 "localabstract:webview_devtools_remote_$p"
$t = (Invoke-WebRequest -Uri "http://127.0.0.1:9223/json/list" -UseBasicParsing).Content | ConvertFrom-Json
$ws = $t[0].webSocketDebuggerUrl
```

The pid changes every launch, so re-forward after every `am start` or install.

## Opening a log without touching the screen

The app has no storage permission, so a raw `/sdcard` path cannot be read — it
fails with a permission error. Go through a content URI, which is the real
import path:

```powershell
& $adb -s $device push .\fixtures\synthetic\rf46-gain-fault.TXT /sdcard/Download/x.TXT
& $adb -s $device shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/x.TXT"
$row = (& $adb -s $device shell "content query --uri content://media/external/file --projection _id:_display_name --sort '_id DESC'") | Select-String "x.TXT" | Select-Object -First 1
$id = [regex]::Match($row, '_id=(\d+)').Groups[1].Value
& $adb -s $device shell "am start -a android.intent.action.VIEW -d content://media/external/file/$id -t text/plain -n app.rotorlens/.MainActivity --grant-read-uri-permission"
```

Give it 8–15 seconds for a large log, then re-forward (new pid) and attach.

## Asking the page

Write a small `.mjs` in the scratchpad and run it with the ws URL as argv. Node
22 has a global `WebSocket`; no dependency is needed.

```js
const socket = new WebSocket(process.argv[2]);
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) => {
  const id = nextId++;
  socket.send(JSON.stringify({id, method, params}));
  return new Promise(resolve => pending.set(id, resolve));
};
const evaluate = async expression => {
  const result = await send('Runtime.evaluate',
    {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text);
  }
  return result.result.value;
};

await new Promise(resolve => socket.addEventListener('open', resolve));
await send('Runtime.enable');
// ... evaluate(...) ...
socket.close();
```

Also subscribe to `Runtime.exceptionThrown` and print what arrives. A throw in
`app.mjs` reaches the phone as a blank screen and nothing else will tell you.

## What to ask for

The sweep worth running after any ui/ change:

- **Every panel by id.** `document.querySelectorAll('section[id]')`, reporting
  `hidden` or its height. Never a hand-picked few.
- **Canvases**: css size, backing size, and how many pixels have non-zero alpha.
  A canvas that exists but painted nothing is the failure a screenshot hides.
  Backing size should be css width × devicePixelRatio; it was hard-coded to 1600
  once, which put a one-second step response in 2.9 CSS pixels.
- **Horizontal overflow**, ignoring anything inside `.scroll`. A scroll container
  is allowed to be wider than the page; the page is not. Not excluding them
  produces a false positive — that happened.
- **Controls under 44 px tall.** Everything the app ships must clear it; they
  were 30–40 px until measured on hardware.
- **`performance.memory.usedJSHeapSize`**, and `ps -A -o RSS` for the process.
  RSS peaked at 241 MB on a 128 MB log against Android caps commonly 192–256 MB.

## Watching the native import events

The shell emits `rotorlens-import-started` and `rotorlens-import-progress`.
Install listeners **before** the import starts — they cannot be recovered
afterwards:

```js
await evaluate(`(() => {
  globalThis.__import = [];
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  for (const name of ['started', 'progress']) {
    addEventListener('rotorlens-import-' + name,
      e => globalThis.__import.push({kind: name, at: at(), ...e.detail}));
  }
  addEventListener('rotorlens-file', e => globalThis.__import.push({kind: 'ready', at: at()}));
  return 'listening';
})()`);
```

Measured on a real board: 85,538,816 bytes at 784 KiB/s over 106 s, 219 progress
events, monotonic, median gap **489 ms** — the 200 ms constant is a floor, not a
period. Do not assume it.

## Things to watch out for

- **Getting the ws URL in PowerShell and passing it to Node as an argument is
  the path proven to work**, many times over. Do that and nothing below matters.
- **`fetch` against `127.0.0.1:9223/json/list` timed out from Node** while
  PowerShell's `Invoke-WebRequest` answered instantly. `node:http` against the
  same URL DID succeed, but took a very long time to come back — and the adb
  forward was being torn down and remade underneath it at the time, so that
  measurement is not clean either. Treat Node-side HTTP to the devtools endpoint
  as unreliable rather than impossible, and prefer the argument.
- **Long runs on a loaded machine look exactly like hangs.** With gradle builds
  and test suites running, several commands here hit the harness timeout and
  were reported as hanging when they were only slow — and one "failure" turned
  out to be MODULE_NOT_FOUND against a file that had already been deleted.
  Before concluding a tool is broken, check the machine is quiet and read the
  actual output rather than the timeout.
- **`DOM.setFileInputFiles` with a `/sdcard` path.** The file input takes it, but
  the app has no storage permission, so reading fails with "Could not read the
  file". Use the content-URI intent above.
- **Backticks inside a CDP template literal.** A comment containing one closed
  the string and produced `SyntaxError: Unexpected identifier`. Avoid them in
  injected source.
- **A `tools/device-check.mjs` wrapper was written and deleted, and the reason
  given for deleting it was wrong.** It appeared to hang; the evidence was three
  harness timeouts on a machine busy with gradle and the test suite, and a final
  MODULE_NOT_FOUND from the file having already been removed. Its failure was
  never actually established. If a wrapper is wanted, rebuild it — take the ws
  URL as an argument, keep adb in the shell, and test it on a quiet machine.
