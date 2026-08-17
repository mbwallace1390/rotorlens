#!/usr/bin/env node

/**
 * Static server for the viewer shell.
 *
 * The UI loads `src/` directly as ES modules, so it needs to be served over HTTP
 * rather than opened from disk — browsers refuse module imports over file://.
 * Serving from the repository root is what lets `ui/app.mjs` import `../src/...`
 * with no bundler and no copy of the engine.
 *
 * Development only: it binds to localhost and serves nothing outside the repo.
 */

import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT ?? 8173);

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml']
]);

export function createUiServer() {
  return createServer(async (request, response) => {
    // Inside the try-of-this-function's error handling, not outside it: both
    // `new URL` and `decodeURIComponent` throw on a malformed request
    // (`GET /%zz`), and an exception in an async http handler is an unhandled
    // rejection that kills the whole process — one stray request took down the
    // dev server, and with it every remaining browser test running against it.
    let requested;
    try {
      requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, {'Content-Type': 'text/plain'}).end('Bad request');
      return;
    }

    // Redirect rather than serving ui/index.html at "/": the browser resolves a
    // page's relative script paths against the document URL, so serving it at the
    // root makes "./app.mjs" resolve to "/app.mjs" and 404 — the page renders but
    // its JavaScript never runs.
    if (requested === '/') {
      response.writeHead(302, {Location: '/ui/'}).end();
      return;
    }

    const target = path.join(projectRoot, requested);

    // Never serve outside the repository, whatever the path contains.
    if (!target.startsWith(projectRoot + path.sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    try {
      const info = await stat(target);
      const file = info.isDirectory() ? path.join(target, 'index.html') : target;
      const body = await readFile(file);

      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES.get(path.extname(file)) ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch {
      response.writeHead(404, {'Content-Type': 'text/plain'}).end('Not found');
    }
  });
}

// process.argv[1] is a Windows path (C:...) while import.meta.url is a file:// URL,
// so comparing them as strings made every one of these CLIs a silent no-op on
// Windows: `npm run fixtures:generate` printed nothing and wrote nothing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createUiServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`RotorLens UI: http://127.0.0.1:${port}/\n`);
  });
}
