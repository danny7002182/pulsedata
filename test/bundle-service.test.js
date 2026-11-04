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

test('bundle checkout fails closed with a correlated configuration error', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-bundles-config-'));
  const dataFile = path.join(tempDir, 'orders.json');
  const previousFile = process.env.DATA_BUNDLE_DATA_FILE;
  process.env.DATA_BUNDLE_DATA_FILE = dataFile;
  let payCalls = 0;
  const route = createBundleRoute({
    getBase: () => 'https://data.example.test',
    getConfig: () => ({ siteBBaseConfigured: false, requireHttps: true, paystackConfigured: false, paystackApiConfigured: false }),
    pay: async () => { payCalls += 1; return {}; }
  });

  try {
    const result = response();
    await route(request('POST', '/api/v1/data-bundles/initialize', JSON.stringify({ network: 'mtn', sizeGb: 1, recipient: '0240000000' })), result);
    const body = JSON.parse(result.body);
    assert.equal(result.status, 503);
    assert.equal(body.code, 'PAYMENT_SERVICE_NOT_CONFIGURED');
    assert.match(body.requestId, /^req_/);
    assert.equal(payCalls, 0);
    assert.equal(fs.existsSync(dataFile), false);
  } finally {
    if (previousFile === undefined) delete process.env.DATA_BUNDLE_DATA_FILE;
    else process.env.DATA_BUNDLE_DATA_FILE = previousFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle Paystack initialization failure preserves a recoverable order', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-bundles-failure-'));
  const dataFile = path.join(tempDir, 'orders.json');
  const previousFile = process.env.DATA_BUNDLE_DATA_FILE;
  process.env.DATA_BUNDLE_DATA_FILE = dataFile;
  const route = createBundleRoute({
    getBase: () => 'https://data.example.test',
    getConfig: () => ({ siteBBaseConfigured: true, requireHttps: true, paystackConfigured: true, paystackApiConfigured: true }),
    pay: async () => { throw new Error('Paystack request failed.'); }
  });

  try {
    const result = response();
    const requestValue = 'bundle-init-failure-1';
    const stream = request('POST', '/api/v1/data-bundles/initialize', JSON.stringify({ network: 'mtn', sizeGb: 1, recipient: '0240000000' }));
    stream.headers['x-request-id'] = requestValue;
    await route(stream, result);
    const body = JSON.parse(result.body);
    const order = JSON.parse(fs.readFileSync(dataFile, 'utf8')).orders[0];
    assert.equal(result.status, 502);
    assert.equal(body.code, 'PAYSTACK_INITIALIZATION_FAILED');
    assert.equal(body.requestId, requestValue);
    assert.equal(body.handoffUrl, undefined);
    assert.equal(order.paymentStatus, 'INITIALIZATION_FAILED');
    assert.equal(order.status, 'PAYMENT_INITIALIZATION_FAILED');
    assert.equal(order.authorizationUrl, undefined);
  } finally {
    if (previousFile === undefined) delete process.env.DATA_BUNDLE_DATA_FILE;
    else process.env.DATA_BUNDLE_DATA_FILE = previousFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle handoff rejects invalid and expired opaque tokens', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-bundles-expiry-'));
  const dataFile = path.join(tempDir, 'orders.json');
  const previousFile = process.env.DATA_BUNDLE_DATA_FILE;
  process.env.DATA_BUNDLE_DATA_FILE = dataFile;
  const route = createBundleRoute({
    getBase: () => 'https://data.example.test',
    getConfig: () => ({ siteBBaseConfigured: true, requireHttps: true, paystackConfigured: true, paystackApiConfigured: true }),
    pay: async () => ({ authorization_url: 'https://checkout.paystack.com/test' })
  });

  try {
    const invalid = response();
    await route(request('GET', '/data/payment/handoff?token=bad'), invalid);
    assert.equal(invalid.status, 404);

    const initialized = response();
    await route(request('POST', '/api/v1/data-bundles/initialize', JSON.stringify({ network: 'mtn', sizeGb: 1, recipient: '0240000000' })), initialized);
    const handoffUrl = JSON.parse(initialized.body).handoffUrl;
    const store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    store.orders[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(dataFile, JSON.stringify(store));
    const expired = response();
    await route(request('GET', new URL(handoffUrl).pathname + new URL(handoffUrl).search), expired);
    assert.equal(expired.status, 410);
  } finally {
    if (previousFile === undefined) delete process.env.DATA_BUNDLE_DATA_FILE;
    else process.env.DATA_BUNDLE_DATA_FILE = previousFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
