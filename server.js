import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const PORT = parseInt(process.env.PORT || '3000');
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com/anthropic';
const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS || '500');
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || '2097152');
const TRACE_DIR = path.resolve(process.env.TRACE_DIR || './traces');
const UI_DIR = path.resolve(process.env.UI_PATH || './public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// In-memory request store
const store = [];
let nextId = 1;

// SSE clients
const sseClients = new Set();

// Ensure trace directory exists
fs.mkdirSync(TRACE_DIR, { recursive: true });

function addEntry(entry) {
  store.push(entry);
  while (store.length > MAX_REQUESTS) store.shift();
}

function truncateBody(body) {
  if (!body) return null;
  if (body.length > MAX_BODY_SIZE) {
    return { truncated: true, preview: body.slice(0, MAX_BODY_SIZE), fullSize: body.length };
  }
  return body;
}

function slimEntry(e) {
  return {
    id: e.id,
    method: e.method,
    pathname: e.pathname,
    startTime: e.startTime,
    status: e.status,
    duration: e.duration,
    requestSize: e.requestSize,
    responseSize: e.responseSize,
    error: e.error,
  };
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// === Save trace to markdown ===
function saveTrace(entry, rawReqBody, rawResBody) {
  const ts = new Date(entry.startTime);
  const dateStr = ts.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `req-${String(entry.id).padStart(4, '0')}-${dateStr}`;

  // Save body files
  const reqFile = saveBodyFile(baseName, 'request', rawReqBody || entry.requestBody);
  const resFile = saveBodyFile(baseName, 'response', rawResBody || entry.responseBody);

  const status = entry.error ? 'Error' : String(entry.status || 'pending');
  const duration = entry.duration != null ? `${entry.duration}ms` : '-';

  const reqSize = entry.requestSize ?? 0;
  const resSize = entry.responseSize ?? 0;

  const md = [
    `# Request #${entry.id}`,
    '',
    `| 字段 | 值 |`,
    `|------|----|`,
    `| Method | ${entry.method} |`,
    `| Path | \`${entry.pathname}\` |`,
    `| Time | ${entry.startTime} |`,
    `| Duration | ${duration} |`,
    `| Status | ${status} |`,
    entry.error ? `| Error | ${entry.error} |` : '',
    `| Request Size | ${formatSize(reqSize)} |`,
    `| Response Size | ${formatSize(resSize)} |`,
    '',
    '## Request Headers',
    '',
    entry.requestHeaders ? fmtHeaders(entry.requestHeaders) : '*(none)*',
    '',
    '## Request Body',
    '',
    reqFile ? `[${reqFile}](${reqFile}) (${formatSize(reqSize)})` : '*(empty)*',
    '',
    '## Response Headers',
    '',
    entry.responseHeaders ? fmtHeaders(entry.responseHeaders) : '*(none)*',
    '',
    '## Response Body',
    '',
    resFile ? `[${resFile}](${resFile}) (${formatSize(resSize)})` : entry.error ? `Proxy error: ${entry.error}` : '*(empty)*',
    '',
  ].filter(Boolean).join('\n');

  const filepath = path.join(TRACE_DIR, `${baseName}.md`);
  fs.writeFileSync(filepath, md, 'utf-8');
  console.log(`[cc-api-tracer] Trace saved: ${filepath}`);
}

function saveBodyFile(baseName, label, body) {
  if (!body) return null;
  const raw = typeof body === 'string' ? body : (body.preview || '');
  if (!raw) return null;

  let ext, content;
  try {
    content = JSON.stringify(JSON.parse(raw), null, 2);
    ext = 'json';
  } catch {
    content = raw;
    ext = 'txt';
  }

  const filename = `${baseName}-${label}.${ext}`;
  fs.writeFileSync(path.join(TRACE_DIR, filename), content, 'utf-8');
  return filename;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtHeaders(headers) {
  return Object.entries(headers)
    .map(([k, v]) => `- **${k}:** ${k === 'authorization' ? maskAuth(v) : v}`)
    .join('\n');
}

function maskAuth(val) {
  if (!val) return '';
  const m = val.match(/^(Bearer\s+)?(.+)$/i);
  if (!m) return val;
  const prefix = m[1] || '';
  const key = m[2];
  if (key.length <= 8) return prefix + key;
  return prefix + key.slice(0, 4) + '****' + key.slice(-4);
}

// === SSE handler ===
function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send all existing entries to the new client
  for (const e of store) {
    res.write(`event: request-start\ndata: ${JSON.stringify(slimEntry(e))}\n\n`);
    if (e.status != null) {
      res.write(`event: request-end\ndata: ${JSON.stringify(slimEntry(e))}\n\n`);
    }
  }

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// === API handlers ===
function handleGetRequests(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(store));
}

function handleClearRequests(req, res) {
  store.length = 0;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ ok: true }));
}

// === Static file serving ===
function serveStatic(req, res, url) {
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  // Sanitize to prevent directory traversal
  filePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(UI_DIR, filePath);

  if (!fullPath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      const ext = path.extname(fullPath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// === Read request body ===
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// === Proxy handler ===
async function handleProxy(clientReq, clientRes, url) {
  const bodyBuffer = await readBody(clientReq);
  const startTime = Date.now();
  const requestBody = bodyBuffer.length > 0 ? bodyBuffer.toString('utf-8') : null;

  const entry = {
    id: nextId++,
    method: clientReq.method,
    pathname: url.pathname + url.search,
    startTime: new Date().toISOString(),
    requestHeaders: { ...clientReq.headers },
    requestBody: truncateBody(requestBody),
    requestSize: bodyBuffer.length,
    status: null,
    duration: null,
    responseHeaders: null,
    responseBody: null,
    responseSize: null,
    error: null,
  };

  addEntry(entry);
  broadcast('request-start', slimEntry(entry));

  try {
    const forwardUrl = DEEPSEEK_BASE + url.pathname + url.search;
    const fwdHeaders = { ...clientReq.headers };
    delete fwdHeaders.host;
    delete fwdHeaders.connection;
    delete fwdHeaders['transfer-encoding'];
    delete fwdHeaders['keep-alive'];

    const deepseekRes = await fetch(forwardUrl, {
      method: clientReq.method,
      headers: fwdHeaders,
      body: bodyBuffer.length > 0 ? bodyBuffer : undefined,
    });

    // Collect response headers
    const resHeaders = {};
    for (const [k, v] of deepseekRes.headers) resHeaders[k] = v;

    // Forward status and headers to the client
    clientRes.writeHead(deepseekRes.status, resHeaders);

    if (!deepseekRes.body) {
      clientRes.end();
      entry.status = deepseekRes.status;
      entry.responseHeaders = resHeaders;
      entry.responseBody = null;
      entry.responseSize = 0;
      entry.duration = Date.now() - startTime;
      addEntry(entry);
      broadcast('request-end', slimEntry(entry));
      saveTrace(entry, requestBody, null);
      return;
    }

    // Stream the response: forward each chunk, accumulate for storage
    const reader = deepseekRes.body.getReader();
    const chunks = [];
    let done = false;

    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) {
        chunks.push(Buffer.from(result.value));
        // Write directly — don't await, let it buffer naturally
        clientRes.write(result.value);
      }
    }
    clientRes.end();

    const fullBody = Buffer.concat(chunks);
    entry.status = deepseekRes.status;
    entry.responseHeaders = resHeaders;
    entry.responseBody = truncateBody(fullBody.toString('utf-8'));
    entry.responseSize = fullBody.length;
    entry.duration = Date.now() - startTime;

    // Update the stored entry in-place (it's already in the array)
    Object.assign(
      store.find((e) => e.id === entry.id),
      entry
    );
    broadcast('request-end', slimEntry(entry));
    saveTrace(entry, requestBody, fullBody.toString('utf-8'));
  } catch (err) {
    entry.error = err.message;
    entry.duration = Date.now() - startTime;
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'proxy_error', message: err.message }));
    }
    broadcast('request-end', slimEntry(entry));
    saveTrace(entry, requestBody, null);
  }
}

// === CORS for API routes ===
function handleCORS(req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
  res.end();
}

// === Main server ===
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') return handleCORS(req, res);

  if (url.pathname === '/events') {
    return handleSSE(req, res);
  }
  if (url.pathname === '/api/requests' && req.method === 'GET') {
    return handleGetRequests(req, res);
  }
  if (url.pathname === '/api/clear' && req.method === 'POST') {
    return handleClearRequests(req, res);
  }
  if (url.pathname === '/' || url.pathname.startsWith('/static/') || isStaticFile(url.pathname)) {
    return serveStatic(req, res, url);
  }

  // Everything else → proxy to DeepSeek
  return handleProxy(req, res, url);
});

function isStaticFile(pathname) {
  const ext = path.extname(pathname);
  return ext in MIME;
}

server.listen(PORT, () => {
  console.log(`[cc-api-tracer] Proxy server running on http://localhost:${PORT}`);
  console.log(`[cc-api-tracer] Forwarding requests to ${DEEPSEEK_BASE}`);
  console.log(`[cc-api-tracer] Web UI: http://localhost:${PORT}`);
});
