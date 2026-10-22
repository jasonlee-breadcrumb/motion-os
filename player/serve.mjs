#!/usr/bin/env node
// Motion OS player server. Serves the player page plus one project folder (reel.json, the video, assets/)
// on localhost and opens it in the browser. No dependencies.
//   node serve.mjs <project-dir> [--port 4321] [--no-open]
//   node serve.mjs --selftest
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {exec, spawn} from 'node:child_process';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

// "bytes=0-99" / "bytes=100-" / "bytes=-100" -> [start, end] inclusive, or null if unusable.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end && start < size ? [start, end] : null;
}

if (process.argv[2] === '--selftest') {
  const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
  eq(parseRange('bytes=0-99', 1000), [0, 99]);
  eq(parseRange('bytes=900-', 1000), [900, 999]);
  eq(parseRange('bytes=-100', 1000), [900, 999]);
  eq(parseRange('bytes=0-5000', 1000), [0, 999]);
  eq(parseRange('bytes=1000-', 1000), null);
  eq(parseRange('bytes=-', 1000), null);
  eq(parseRange(undefined, 1000), null);
  console.log('selftest ok');
  process.exit(0);
}

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, name === '--no-open' ? 1 : 2)[1] ?? true; };
const noOpen = flag('--no-open');
const portArg = flag('--port');
let port = portArg === true ? NaN : Number(portArg || process.env.PORT || 4321);  // a bare --port is an error, not port 1
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('Motion OS: --port needs a number from 1 to 65535'); process.exit(1); }
const dir = path.resolve(args[0] || '.');
const page = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html');
const token = crypto.randomBytes(16).toString('hex');  // handed to our page only; required to start an export
if (!fs.existsSync(path.join(dir, 'reel.json'))) { console.error(`Motion OS: no reel.json in ${dir}`); process.exit(1); }

// Export: reel.json "export": {"cwd": build folder, "cmd": shell command}. The command gets $PROPS (a JSON file with the
// user's edits), $RAW (temp render path), $OUT (final mp4 in <project>/exports/) and $PROJECT. One export at a time.
let job = {state: 'idle'};
function startExport(props) {
  const reel = JSON.parse(fs.readFileSync(path.join(dir, 'reel.json'), 'utf8')), ex = reel.export;
  if (!ex) return {state: 'error', line: 'This project has no "export" in reel.json.'};
  if (job.state === 'running') return job;
  const cwd = path.resolve(dir, ex.cwd || '.');  // a relative cwd is relative to the project
  if (!fs.existsSync(cwd)) return {state: 'error', line: `The export folder doesn't exist: ${cwd}`};
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  fs.mkdirSync(path.join(dir, 'exports'), {recursive: true});
  const out = path.join(dir, 'exports', `${reel.id}-${stamp}.mp4`), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motionos-'));
  const env = {...process.env, PROJECT: dir, OUT: out, RAW: path.join(tmp, 'raw.mp4'), PROPS: path.join(tmp, 'props.json')};
  fs.writeFileSync(env.PROPS, JSON.stringify({...ex.props, ...props}));
  job = {state: 'running', pct: 0, line: 'Starting', out: path.relative(dir, out)};
  const p = spawn('sh', ['-c', ex.cmd], {cwd, env});
  const onData = (d) => {
    const text = String(d), m = [...text.matchAll(/(\d+)\/(\d+)/g)].pop();
    if (m && +m[2] > 0) job.pct = Math.min(99, Math.round(+m[1] / +m[2] * 100));
    const last = text.trim().split(/[\r\n]+/).pop(); if (last) job.line = last.slice(0, 200);
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  // A command that can't start (missing cwd, no sh) emits 'error'; without a listener that would crash the server.
  p.on('error', (e) => { job = {...job, state: 'error', line: `Couldn't start the export: ${e.message}`}; });
  p.on('close', (code) => {
    if (job.state === 'running') job = code === 0 && fs.existsSync(out) ? {...job, state: 'done', pct: 100}
      : {...job, state: 'error', line: code === 0 ? 'The export command finished but never wrote $OUT.' : job.line};
    fs.rmSync(tmp, {recursive: true, force: true});
  });
  return job;
}

const server = http.createServer((req, res) => {
  // Answer only requests addressed to this machine by name. Blocks DNS-rebinding pages from reading the project.
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return res.writeHead(403).end('Forbidden');
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return res.writeHead(400).end('Bad request'); }  // e.g. "/%E0": a malformed URL must not take the server down
  if (url === '/__motionos') return res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({dir}));  // see 'error' below
  if (url === '/export') {
    // Only our own page may start a render: it sends this run's token, which other sites can't read. The custom header
    // also forces a CORS preflight that we never approve.
    if (req.method === 'POST' && req.headers['x-motionos-token'] !== token) return res.writeHead(403).end();
    const send = (j) => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(j));
    if (req.method !== 'POST') return send(job);
    let body = ''; req.on('data', (c) => body += c);
    return req.on('end', () => { try { send(startExport(JSON.parse(body || '{}'))); } catch (e) { send({state: 'error', line: e.message}); } });
  }
  if (url === '/') return fs.readFile(page, 'utf8', (err, html) => err ? res.writeHead(500).end()
    : res.writeHead(200, {'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store'}).end(html.replace('name="motionos-token" content=""', `name="motionos-token" content="${token}"`)));
  let file = path.resolve(dir, '.' + url);
  if (!file.startsWith(dir + path.sep)) return res.writeHead(403).end('Forbidden');
  // Remotion's staticFile() paths point at the site root; serve them from public/.
  if (!fs.existsSync(file) && fs.existsSync(path.join(dir, 'public', '.' + url))) file = path.join(dir, 'public', '.' + url);
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return res.writeHead(404).end('Not found');
    // The file can vanish between stat and read (Claude re-rendering video.mp4); drop the response instead of crashing.
    const stream = (opts) => fs.createReadStream(file, opts).on('error', () => res.destroy()).pipe(res);
    const head = {'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'};
    if (req.headers.range) {  // video seeking needs byte ranges
      const r = parseRange(req.headers.range, stat.size);
      if (!r) return res.writeHead(416, {'Content-Range': `bytes */${stat.size}`}).end();
      res.writeHead(206, {...head, 'Content-Range': `bytes ${r[0]}-${r[1]}/${stat.size}`, 'Content-Length': r[1] - r[0] + 1});
      return req.method === 'HEAD' ? res.end() : stream({start: r[0], end: r[1]});
    }
    res.writeHead(200, {...head, 'Content-Length': stat.size});
    req.method === 'HEAD' ? res.end() : stream();
  });
});

const open = (url) => noOpen || exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open'} ${url}`);
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') { console.error(`Motion OS: can't listen on port ${port}: ${e.message}`); process.exit(1); }
  // If the port already serves this project, reuse it rather than starting a second server on the next port. Edits are
  // saved per origin (port included), so a new port would make them look lost and two tabs would overwrite each other.
  let done = false;
  const next = () => { if (done) return; done = true; port += 1; server.listen(port, '127.0.0.1'); };  // try the next port
  http.get(`http://127.0.0.1:${port}/__motionos`, (r) => {
    let body = ''; r.on('data', (c) => body += c);
    r.on('end', () => {
      let same = false; try { same = JSON.parse(body).dir === dir; } catch {}
      if (!same) return next();
      done = true; console.log(`Motion OS: already running at http://localhost:${port}  (project: ${dir})`); open(`http://localhost:${port}`); process.exit(0);
    });
  }).on('error', next).setTimeout(1000, function () { this.destroy(); });
});
server.on('listening', () => {
  const url = `http://localhost:${port}`;
  console.log(`Motion OS: ${url}  (project: ${dir})  Ctrl+C to stop`);
  open(url);
});
server.listen(port, '127.0.0.1');
