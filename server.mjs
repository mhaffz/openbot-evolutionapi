import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
const openbotUrl = required('OPENBOT_WEBHOOK_URL');
const sharedSecret = required('WEBHOOK_SHARED_SECRET');
const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? 'Paut';
const maxBodyBytes = 1024 * 1024;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function decodePart(value) {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function validEvolutionJwt(header, secret) {
  const match = /^Bearer\s+([^.]+\.[^.]+\.[^.]+)$/i.exec(header ?? '');
  if (!match) return false;

  const token = match[1];
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
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
    if (/^(apikey|authorization|jwt_key|token|headers)$/i.test(key)) continue;
    cleaned[key] = removeSecrets(child);
  }
  return cleaned;
}

function deliveryId(payload, rawBody) {
  const messageId = payload?.data?.key?.id ?? payload?.data?.message?.key?.id;
  if (typeof messageId === 'string' && messageId.length > 0) {
    return `evo-${createHash('sha256').update(messageId).digest('hex')}`;
  }
  return `evo-${createHash('sha256').update(rawBody).digest('hex')}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { status: 'ok' });
  }
  if (req.method !== 'POST' || req.url !== '/evolution') {
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

    const receivedInstance = event?.instance;
    if (receivedInstance && receivedInstance !== instanceName) {
      return json(res, 200, { status: 'ignored_wrong_instance' });
    }
    if (eventName(event) !== 'MESSAGES_UPSERT') {
      return json(res, 200, { status: 'ignored_event' });
    }

    const body = JSON.stringify({
      type: 'MESSAGES_UPSERT',
      occurredAt: new Date().toISOString(),
      data: removeSecrets(event),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const id = deliveryId(event, rawBody);
    const signature = createHmac('sha256', sharedSecret)
      .update(`${timestamp}.${id}.${body}`)
      .digest('hex');

    const response = await fetch(openbotUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openbot-timestamp': timestamp,
        'x-openbot-delivery-id': id,
        'x-openbot-signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return json(res, 202, { status: 'forwarded' });
    }
    // Do not log or return the upstream response body; it can contain customer data.
    console.error(`OpenBot webhook returned HTTP ${response.status}`);
    return json(res, 502, { error: 'openbot_forward_failed' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown_error';
    if (reason === 'body_too_large') return json(res, 413, { error: reason });
    console.error(`Webhook bridge failed: ${reason}`);
    return json(res, 500, { error: 'bridge_error' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Webhook bridge listening on port ${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
