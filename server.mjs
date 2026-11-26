import { createCipheriv, createDecipheriv, createHash, createHmac, timingSafeEqual, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
const sharedSecret = required('WEBHOOK_SHARED_SECRET');
const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? 'Paut';
const queueDir = process.env.QUEUE_DIR ?? '/data/queue';
const receiptsDir = process.env.RECEIPTS_DIR ?? '/data/receipts';
const maxBodyBytes = 1024 * 1024;
const maxQueueItems = Number(process.env.MAX_QUEUE_ITEMS ?? 2000);
const retentionMs = Number(process.env.QUEUE_RETENTION_HOURS ?? 24) * 60 * 60 * 1000;
const queueToken = createHmac('sha256', sharedSecret)
  .update('openbot-evolution-local-queue-v1')
  .digest('hex');
const queueEncryptionKey = createHmac('sha256', sharedSecret)
  .update('openbot-evolution-queue-encryption-v1')
  .digest();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hasQueueAuth(req) {
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.headers.authorization ?? '');
  return Boolean(match && safeEqual(match[1].toLowerCase(), queueToken));
}

function encryptRecord(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', queueEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decryptRecord(envelope) {
  if (envelope?.version !== 1) throw new Error('unsupported_queue_record');
  const decipher = createDecipheriv('aes-256-gcm', queueEncryptionKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function decodePart(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function validEvolutionJwt(header, secret) {
  const match = /^Bearer\s+([^.]+\.[^.]+\.[^.]+)$/i.exec(header ?? '');
  if (!match) return false;

  const [encodedHeader, encodedPayload, encodedSignature] = match[1].split('.');
  let jwtHeader;
  let payload;
  try {
    jwtHeader = JSON.parse(decodePart(encodedHeader));
    payload = JSON.parse(decodePart(encodedPayload));
  } catch {
    return false;
  }
  if (jwtHeader.alg !== 'HS256') return false;

  const expected = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const received = Buffer.from(encodedSignature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) return false;
  if (typeof payload.iat === 'number' && payload.iat > now + 60) return false;
  return true;
}

function eventName(payload) {
  const raw = payload?.event ?? payload?.type ?? '';
  return String(raw).replace(/[.\s-]+/g, '_').toUpperCase();
}

function removeSecrets(value) {
  if (Array.isArray(value)) return value.map(removeSecrets);
  if (!value || typeof value !== 'object') return value;
  const cleaned = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(apikey|authorization|jwt_key|token|headers|base64|mediadata|mediabytes|buffer|mediakey|filesha256|fileencsha256|directpath)$/i.test(key)) continue;
    cleaned[key] = removeSecrets(child);
  }
  return cleaned;
}

function deliveryId(payload, rawBody) {
  const messageId = payload?.data?.key?.id ?? payload?.data?.message?.key?.id;
  const source = typeof messageId === 'string' && messageId.length > 0 ? messageId : rawBody;
  return `evo-${createHash('sha256').update(source).digest('hex')}`;
}

async function readBody(req, limit = maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonFiles(directory) {
  const names = await fs.readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) items.push({ name, file, mtimeMs: stat.mtimeMs });
  }
  return items.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function pruneExpired() {
  const cutoff = Date.now() - retentionMs;
  for (const item of await jsonFiles(queueDir)) {
    if (item.mtimeMs < cutoff) await fs.unlink(item.file).catch(() => {});
  }
  for (const item of await jsonFiles(receiptsDir)) {
    if (item.mtimeMs < cutoff) await fs.unlink(item.file).catch(() => {});
  }
}

function idPath(directory, id) {
  if (!/^evo-[a-f0-9]{64}$/.test(id)) return null;
  return path.join(directory, `${id}.json`);
}

async function isReceipt(id) {
  const file = idPath(receiptsDir, id);
  if (!file) return false;
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function enqueue(id, event) {
  await pruneExpired();
  if (await isReceipt(id)) return 'duplicate';

  const file = idPath(queueDir, id);
  if (!file) throw new Error('invalid_queue_id');
  try {
    await fs.access(file);
    return 'duplicate';
  } catch {
    // Continue when the queue file does not exist.
  }

  if ((await jsonFiles(queueDir)).length >= maxQueueItems) throw new Error('queue_full');
  const tmp = `${file}.${randomUUID()}.tmp`;
  const record = encryptRecord(JSON.stringify({ id, receivedAt: new Date().toISOString(), event }));
  await fs.writeFile(tmp, record, { mode: 0o600, flag: 'wx' });
  try {
    await fs.link(tmp, file);
    return 'queued';
  } catch (error) {
    if (error.code === 'EEXIST') return 'duplicate';
    throw error;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function acknowledge(id) {
  const file = idPath(queueDir, id);
  if (!file) return false;
  const receipt = idPath(receiptsDir, id);
  await fs.writeFile(receipt, JSON.stringify({ acknowledgedAt: new Date().toISOString() }), { mode: 0o600 });
  await fs.unlink(file).catch(() => {});
  return true;
}

async function nextEvent() {
  await pruneExpired();
  const [first] = await jsonFiles(queueDir);
  if (!first) return null;
  const envelope = JSON.parse(await fs.readFile(first.file, 'utf8'));
  return JSON.parse(decryptRecord(envelope));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    try {
      return json(res, 200, { status: 'ok', queued: (await jsonFiles(queueDir)).length });
    } catch {
      return json(res, 500, { error: 'queue_unavailable' });
    }
  }

  if (url.pathname === '/queue/next' || url.pathname === '/queue/ack') {
    if (!hasQueueAuth(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      if (req.method === 'GET' && url.pathname === '/queue/next') {
        return json(res, 200, { event: await nextEvent() });
      }
      if (req.method === 'POST' && url.pathname === '/queue/ack') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        if (typeof body.id !== 'string' || !idPath(queueDir, body.id)) {
          return json(res, 400, { error: 'invalid_id' });
        }
        await acknowledge(body.id);
        return json(res, 200, { status: 'acknowledged' });
      }
      return json(res, 405, { error: 'method_not_allowed' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown_error';
      if (reason === 'body_too_large') return json(res, 413, { error: reason });
      console.error(`Queue request failed: ${reason}`);
      return json(res, 500, { error: 'queue_error' });
    }
  }

  if (req.method !== 'POST' || url.pathname !== '/evolution') {
    return json(res, 404, { error: 'not_found' });
  }

  try {
    if (!validEvolutionJwt(req.headers.authorization, sharedSecret)) {
      return json(res, 401, { error: 'invalid_evolution_signature' });
    }

    const rawBody = await readBody(req);
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return json(res, 400, { error: 'invalid_json' });
    }

    if (event?.instance && event.instance !== instanceName) {
      return json(res, 200, { status: 'ignored_wrong_instance' });
    }
    if (eventName(event) !== 'MESSAGES_UPSERT') {
      return json(res, 200, { status: 'ignored_event' });
    }

    const id = deliveryId(event, rawBody);
    const status = await enqueue(id, removeSecrets(event));
    console.info(`Evolution event ${status}: ${id}`);
    return json(res, 202, { status, id });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown_error';
    if (reason === 'body_too_large') return json(res, 413, { error: reason });
    if (reason === 'queue_full') return json(res, 503, { error: reason });
    console.error(`Evolution webhook failed: ${reason}`);
    return json(res, 500, { error: 'bridge_error' });
  }
});

await fs.mkdir(queueDir, { recursive: true, mode: 0o700 });
await fs.mkdir(receiptsDir, { recursive: true, mode: 0o700 });
server.listen(port, '0.0.0.0', () => {
  console.log(`Evolution queue bridge listening on port ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
