'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const PORT = Number(process.env.PORT || 8090);
const SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FROM = process.env.FROM_EMAIL || 'info@comercialplus.es';
const JOIN_URL = process.env.ZOOM_JOIN_URL || '';
const PASSCODE = process.env.ZOOM_PASSCODE || '';
const STATE_DIR = process.env.STATE_DIR || '/var/lib/comercialplus-ia-webhook';
const STATE_FILE = path.join(STATE_DIR, 'processed-events.json');

function signatureIsValid(raw, header) {
  if (!SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=')));
  const timestamp = parts.t;
  const received = parts.v1;
  if (!timestamp || !received || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const signed = `${timestamp}.${raw}`;
  const expected = crypto.createHmac('sha256', SECRET).update(signed).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveProcessed(events) {
  fs.mkdirSync(STATE_DIR, {recursive: true});
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...events].slice(-1000)), {mode: 0o600});
  fs.renameSync(tmp, STATE_FILE);
}

function sendMail(to, name) {
  if (!to || !JOIN_URL) return Promise.resolve(false);
  const access = `Acceso a Zoom: ${JOIN_URL}${PASSCODE ? `\nCódigo de acceso: ${PASSCODE}` : ''}`;
  const body = `Hola ${name || ''},\n\nTu plaza en la Mentoría IA para Líderes de Equipos de Comercial Plus está confirmada.\n\n${access}\n\nFechas: 30 de septiembre, 7, 14 y 21 de octubre de 2026, de 19:00 a 20:00 (España).\n\nSi necesitas ayuda, responde a este correo o escribe a info@comercialplus.es.\n\nUn saludo,\nPablo Blanco Cabirta\nComercial Plus\n`;
  const message = `From: Comercial Plus <${FROM}>\nTo: ${to}\nSubject: Plaza confirmada · Mentoría IA para Líderes de Equipos\nContent-Type: text/plain; charset=UTF-8\n\n${body}`;
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/sbin/sendmail', ['-t', '-oi']);
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(true) : reject(new Error(`sendmail exit ${code}`)));
    proc.stdin.end(message);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/stripe/webhook') {
    res.writeHead(404).end(); return;
  }
  const chunks = [];
  let bytes = 0;
  req.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); });
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (bytes > 1024 * 1024 || !signatureIsValid(raw, req.headers['stripe-signature'])) {
      res.writeHead(400).end('invalid webhook'); return;
    }
    let event;
    try { event = JSON.parse(raw); } catch { res.writeHead(400).end('invalid json'); return; }
    const processed = loadProcessed();
    if (processed.has(event.id)) { res.writeHead(200).end('already processed'); return; }
    if (event.type === 'checkout.session.completed' && event.data?.object?.payment_status === 'paid') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const name = session.customer_details?.name || '';
      try { await sendMail(email, name); } catch (error) { console.error('mail delivery failed', error.message); res.writeHead(500).end('mail failed'); return; }
    }
    processed.add(event.id); saveProcessed(processed);
    res.writeHead(200).end('ok');
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Stripe webhook listening on 127.0.0.1:${PORT}`));
