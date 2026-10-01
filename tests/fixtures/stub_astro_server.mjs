// Reusable stub Astro-instance HTTP server for testing stdlib kit tools
// (phase 106 p1 — _astro_client.py and its callers). Scripts routes with a
// plain handler function, records every request (method, path, headers,
// body), and runs a kit tool's Python child asynchronously so the server's
// event loop keeps serving requests while the tool is in flight.
//
// Node `http` only — this harness, like the kit tools it drives, stays
// dependency-free (C9).

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

/**
 * Start a stub server. `handler(request)` is called once per fully-buffered
 * request, where `request` is `{method, path, headers, body}` (`body` is the
 * raw request body as a utf8 string). It must return:
 *   - `{status, body, headers}` — `body` is JSON-stringified unless it is
 *     already a string; `status` defaults to 200 and `headers` to `{}`;
 *   - `null` — the connection is left open and never answered, for timeout
 *     tests.
 *
 * Resolves to `{url, requests, close}`: `url` is the server's base URL,
 * `requests` is the live array of recorded requests (grows as calls land),
 * and `close()` stops the server.
 */
export function startStubServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const [path] = req.url.split('?');
      const record = { method: req.method, path, url: req.url, headers: req.headers, body };
      requests.push(record);

      let result;
      try {
        result = handler(record);
      } catch (err) {
        result = { status: 500, body: { error: 'stub_handler_threw', message: String(err) } };
      }
      if (result === null) return; // simulate a server that never answers

      const { status = 200, body: resBody, headers = {} } = result || {};
      const payload = resBody === undefined ? '' : typeof resBody === 'string' ? resBody : JSON.stringify(resBody);
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(payload);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Run a kit tool's Python child asynchronously: `python3 -I -S ...args`
 * (isolated, no site-packages — mirrors how the real commands invoke it, and
 * keeps the event loop free so a concurrently-running stub server can answer
 * requests). Resolves to `{status, stdout, stderr}`; `status` is `null` if
 * the process could not be spawned at all (reported via `stderr`).
 */
export function runPython(args, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-I', '-S', ...args], {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => resolve({ status: null, stdout, stderr: `${stderr}${err}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
