'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const PORT = Number(process.env.PORT || 8090);
const SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYMENT_LINK_ID = process.env.MENTOR_PAYMENT_LINK_ID || '';
const FROM = process.env.FROM_EMAIL || 'info@comercialplus.es';
const ADMIN_EMAIL = process.env.ENROLLMENT_NOTIFY_EMAIL || 'info@comercialplus.es';
const STATE_DIR = process.env.STATE_DIR || '/var/lib/comercialplus-ia-webhook';

function signatureIsValid(raw, header, secret, nowSeconds = Date.now() / 1000) {
  if (!secret || !header) return false;
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest();
  return signatures.some((signature) => {
    if (!/^[a-f\d]{64}$/i.test(signature)) return false;
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(expected, received);
  });
}

function loadProcessed(stateFile) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
      throw new Error('invalid processed sessions state');
    }
    return new Set(value);
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

function saveProcessed(stateFile, sessions) {
  fs.mkdirSync(path.dirname(stateFile), {recursive: true, mode: 0o700});
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...sessions]), {mode: 0o600});
  fs.renameSync(tmp, stateFile);
}

function cleanName(name) {
  return String(name || '').replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 &&
    /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email);
}

function buildEnrollmentEmail(to, name, from = FROM, adminEmail = ADMIN_EMAIL) {
  if (!isValidEmail(to)) throw new Error('missing or invalid checkout email');
  if (!isValidEmail(from)) throw new Error('invalid sender email');
  if (!isValidEmail(adminEmail)) throw new Error('invalid enrollment notification email');

  const safeName = cleanName(name);
  const greeting = safeName ? `Hola ${safeName},` : 'Hola,';
  const body = `${greeting}\n\nStripe ha confirmado tu pago y tu plaza en la Mentoría IA para Líderes de Equipos queda reservada.\n\nLa mentoría consta de cuatro encuentros online por Zoom: miércoles 14, 21 y 28 de octubre y 4 de noviembre de 2026, de 19:00 a 20:00 (hora peninsular española).\n\nTe enviaremos el enlace de Zoom y las instrucciones de acceso antes del primer encuentro, en un correo aparte.\n\nSi necesitas ayuda, responde a este correo o escribe a info@comercialplus.es.\n\nUn saludo,\nPablo Blanco Cabirta\nComercial Plus\n`;
  const subject = Buffer.from('Inscripción confirmada · Mentoría IA para Líderes de Equipos', 'utf8').toString('base64');
  const message = `From: Comercial Plus <${from}>\nTo: ${to}\nBcc: ${adminEmail}\nSubject: =?UTF-8?B?${subject}?=\nMIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n\n${body}`;
  return message;
}

function sendEnrollmentEmail(to, name, from = FROM, adminEmail = ADMIN_EMAIL) {
  const message = buildEnrollmentEmail(to, name, from, adminEmail);
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/sbin/sendmail', ['-t', '-oi']);
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`sendmail exit ${code}`)));
    proc.stdin.end(message);
  });
}

function createWebhookServer({secret, paymentLinkID, stateDir, from = FROM, adminEmail = ADMIN_EMAIL, mailer = sendEnrollmentEmail}) {
  const stateFile = path.join(stateDir, 'processed-sessions.json');
  const inFlight = new Set();

  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/stripe/webhook') {
      res.writeHead(404).end();
      return;
    }

    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        res.writeHead(413).end('payload too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!signatureIsValid(raw, req.headers['stripe-signature'], secret)) {
        res.writeHead(400).end('invalid webhook');
        return;
      }

      let event;
      try { event = JSON.parse(raw); }
      catch { res.writeHead(400).end('invalid json'); return; }

      const isCheckoutEvent = event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded';
      const session = event.data?.object;
      if (!isCheckoutEvent || session?.payment_link !== paymentLinkID || session?.payment_status !== 'paid') {
        res.writeHead(200).end('ignored');
        return;
      }
      if (session.currency !== 'eur' || session.amount_total !== 10000) {
        console.error('ignored checkout with unexpected currency or total', session.id);
        res.writeHead(200).end('ignored');
        return;
      }
      if (typeof session.id !== 'string' || !session.id.startsWith('cs_')) {
        res.writeHead(400).end('invalid checkout session');
        return;
      }

      let processed;
      try { processed = loadProcessed(stateFile); }
      catch (error) {
        console.error('could not read processed-session state', error.message);
        res.writeHead(500).end('state unavailable');
        return;
      }
      if (processed.has(session.id)) { res.writeHead(200).end('already processed'); return; }
      if (inFlight.has(session.id)) { res.writeHead(409).end('already processing'); return; }

      const email = session.customer_details?.email || session.customer_email;
      const name = session.customer_details?.name || '';
      if (!isValidEmail(email)) { res.writeHead(503).end('checkout email unavailable'); return; }

      inFlight.add(session.id);
      try {
        await mailer(email, name, from, adminEmail);
        processed.add(session.id);
        saveProcessed(stateFile, processed);
      } catch (error) {
        console.error('enrollment email failed', error.message);
        res.writeHead(500).end('email delivery failed');
        return;
      } finally {
        inFlight.delete(session.id);
      }
      res.writeHead(200).end('ok');
    });
  });
}

if (require.main === module) {
  if (!SECRET || !PAYMENT_LINK_ID) {
    console.error('STRIPE_WEBHOOK_SECRET and MENTOR_PAYMENT_LINK_ID are required');
    process.exit(1);
  }
  const server = createWebhookServer({secret: SECRET, paymentLinkID: PAYMENT_LINK_ID, stateDir: STATE_DIR, from: FROM});
  server.listen(PORT, '127.0.0.1', () => console.log(`Stripe webhook listening on 127.0.0.1:${PORT}`));
}

module.exports = {buildEnrollmentEmail, createWebhookServer, isValidEmail, signatureIsValid};
