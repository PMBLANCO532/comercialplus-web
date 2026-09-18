'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {buildEnrollmentEmail, createWebhookServer} = require('./stripe-webhook');

const secret = 'whsec_test_only';
const paymentLinkID = 'plink_mentor_test';
const adminEmail = 'info@comercialplus.es';

function signedBody(event) {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return {raw, signature: `t=${timestamp},v1=${digest}`};
}

function checkoutEvent(overrides = {}) {
  return {
    id: 'evt_test',
    type: 'checkout.session.completed',
    data: {object: {
      id: 'cs_test_mentor',
      payment_link: paymentLinkID,
      payment_status: 'paid',
      amount_total: 10000,
      currency: 'eur',
      customer_details: {email: 'buyer@example.com', name: 'Ada Líder'},
      ...overrides,
    }},
  };
}

async function setup(mailer) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comercialplus-webhook-'));
  const server = createWebhookServer({secret, paymentLinkID, stateDir, adminEmail, mailer});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    stateDir,
    server,
    async post(event, signatureOverride) {
      const {raw, signature} = signedBody(event);
      return fetch(`http://127.0.0.1:${address.port}/stripe/webhook`, {
        method: 'POST',
        headers: {'content-type': 'application/json', 'stripe-signature': signatureOverride || signature},
        body: raw,
      });
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      fs.rmSync(stateDir, {recursive: true, force: true});
    },
  };
}

test('sends one confirmation for the mentor payment and does not include Zoom access', async () => {
  const sent = [];
  const app = await setup(async (...args) => sent.push(args));
  try {
    const first = await app.post(checkoutEvent());
    const duplicate = await app.post(checkoutEvent({id: 'cs_test_mentor'}));
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'buyer@example.com');
    assert.match(sent[0][1], /Ada Líder/);
    assert.match(sent[0][2], /info@comercialplus\.es/);
    assert.equal(sent[0][3], adminEmail);
    assert.doesNotMatch(sent[0].join('\n'), /zoom\.us|código de acceso/i);
    assert.match(fs.readFileSync(path.join(app.stateDir, 'processed-sessions.json'), 'utf8'), /cs_test_mentor/);
  } finally {
    await app.close();
  }
});

test('confirmation email sends a hidden copy to Comercial Plus', () => {
  const message = buildEnrollmentEmail('buyer@example.com', 'Ada Líder', 'info@comercialplus.es', adminEmail);
  assert.match(message, /To: buyer@example\.com/);
  assert.match(message, /Bcc: info@comercialplus\.es/);
  assert.match(message, /miércoles 14, 21 y 28 de octubre y 4 de noviembre de 2026/);
  assert.doesNotMatch(message, /30 de septiembre/);
  assert.doesNotMatch(message, /zoom\.us|código de acceso/i);
  assert.throws(() => buildEnrollmentEmail('buyer@example.com', 'Ada', 'info@comercialplus.es', 'not-an-email'), /invalid enrollment notification email/);
});

test('ignores unpaid or unrelated checkout sessions', async () => {
  const sent = [];
  const app = await setup(async (...args) => sent.push(args));
  try {
    const unpaid = await app.post(checkoutEvent({payment_status: 'unpaid'}));
    const unrelated = await app.post(checkoutEvent({id: 'cs_other', payment_link: 'plink_other'}));
    const wrongPrice = await app.post(checkoutEvent({id: 'cs_wrong_price', amount_total: 2900}));
    assert.equal(unpaid.status, 200);
    assert.equal(unrelated.status, 200);
    assert.equal(wrongPrice.status, 200);
    assert.equal(sent.length, 0);
  } finally {
    await app.close();
  }
});

test('rejects invalid signatures and retries failed email delivery', async () => {
  let attempts = 0;
  const app = await setup(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary mail failure');
  });
  try {
    const bad = await app.post(checkoutEvent(), 't=1,v1=bad');
    const failed = await app.post(checkoutEvent());
    const retried = await app.post(checkoutEvent());
    assert.equal(bad.status, 400);
    assert.equal(failed.status, 500);
    assert.equal(retried.status, 200);
    assert.equal(attempts, 2);
  } finally {
    await app.close();
  }
});

test('handles asynchronous successful payment events', async () => {
  const sent = [];
  const app = await setup(async (...args) => sent.push(args));
  try {
    const event = checkoutEvent();
    event.type = 'checkout.session.async_payment_succeeded';
    const result = await app.post(event);
    assert.equal(result.status, 200);
    assert.equal(sent.length, 1);
  } finally {
    await app.close();
  }
});
