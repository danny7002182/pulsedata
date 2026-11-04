const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createBundleRoute } = require('../bundle-service');

function request(method, url, body = '') {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  return stream;
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value = '') { this.body = String(value); }
  };
}

test('bundle checkout calculates Ghana network pricing and reconciles a paid order', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-bundles-'));
  const dataFile = path.join(tempDir, 'orders.json');
  const previousFile = process.env.DATA_BUNDLE_DATA_FILE;
  const previousEmail = process.env.DATA_BUNDLE_PAYMENT_EMAIL;
  process.env.DATA_BUNDLE_DATA_FILE = dataFile;
  process.env.DATA_BUNDLE_PAYMENT_EMAIL = 'danny700218+1@gmail.com';
  let initialized;
  const route = createBundleRoute({
    getBase: () => 'http://127.0.0.1:4000',
    pay: async (pathname, options) => {
      if (pathname === '/transaction/initialize') {
        initialized = JSON.parse(options.body);
        return { authorization_url: 'https://checkout.paystack.com/test' };
      }
      assert.match(pathname, /^\/transaction\/verify\//);
      return {
        reference: initialized.reference,
        amount: initialized.amount,
        currency: 'GHS',
        status: 'success',
        metadata: { service: 'PULSE_DATA', orderReference: JSON.parse(fs.readFileSync(dataFile, 'utf8')).orders[0].reference }
      };
    }
  });

  try {
    const initResponse = response();
    await route(request('POST', '/api/v1/data-bundles/initialize', JSON.stringify({ network: 'telecel', sizeGb: 20, recipient: '054 000 0000' })), initResponse);
    assert.equal(initResponse.status, 201);
    const initializedResult = JSON.parse(initResponse.body);
    assert.equal(initialized.amount, 10000);
    assert.equal(initialized.currency, 'GHS');
    assert.ok(initializedResult.reference.startsWith('BNDL_'));
    assert.equal(initializedResult.authorizationUrl, undefined);
    assert.match(initializedResult.handoffUrl, /\/data\/payment\/handoff\?token=[A-Za-z0-9_-]{16,256}$/);

    const handoffResponse = response();
    await route(request('GET', new URL(initializedResult.handoffUrl).pathname + new URL(initializedResult.handoffUrl).search), handoffResponse);
    assert.equal(handoffResponse.status, 302);
    assert.equal(handoffResponse.headers.location, 'https://checkout.paystack.com/test');
    const reusedHandoff = response();
    await route(request('GET', new URL(initializedResult.handoffUrl).pathname + new URL(initializedResult.handoffUrl).search), reusedHandoff);
    assert.equal(reusedHandoff.status, 410);

    const returnResponse = response();
    const resultToken = new URL(initialized.callback_url).searchParams.get('token');
    await route(request('GET', `/data/payment/return?token=${resultToken}`), returnResponse);
    assert.equal(returnResponse.status, 303);
    assert.doesNotMatch(returnResponse.headers.location, /reference|trxref/i);

    const completeResponse = response();
    await route(request('POST', `/api/v1/data-bundles/complete?token=${resultToken}`), completeResponse);
    assert.equal(completeResponse.status, 200);
    const completed = JSON.parse(completeResponse.body);
    assert.equal(completed.status, 'SUCCESS');
    assert.equal(completed.order.status, 'PAID_AWAITING_MANUAL_DELIVERY');
    assert.equal(completed.order.fulfillmentStatus, 'AWAITING_MANUAL_DELIVERY');
    assert.equal(completed.order.recipient, '+233540000000');
  } finally {
    if (previousFile === undefined) delete process.env.DATA_BUNDLE_DATA_FILE;
    else process.env.DATA_BUNDLE_DATA_FILE = previousFile;
    if (previousEmail === undefined) delete process.env.DATA_BUNDLE_PAYMENT_EMAIL;
    else process.env.DATA_BUNDLE_PAYMENT_EMAIL = previousEmail;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
