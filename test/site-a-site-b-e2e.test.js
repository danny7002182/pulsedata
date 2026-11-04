const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

const SITE_A_ROOT = '/home/nilo/final cards/final cards';
const SITE_B_ROOT = path.join(__dirname, '..');
const INIT_SECRET = 'site-a-to-site-b-end-to-end-secret';
const CALLBACK_SECRET = 'site-b-to-site-a-end-to-end-secret';
const PAYSTACK_SECRET = 'sk_test_end_to_end_fixture';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function stop(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
}

async function waitForHealth(base) {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`service did not become healthy: ${base}`);
}

test('complete Site A → Site B → Paystack → Site B → Site A wallet path', { timeout: 30000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payment-e2e-'));
  const siteAData = path.join(tempDir, 'site-a.json');
  const siteBData = path.join(tempDir, 'site-b.json');
  const paystackRequests = [];
  const paystack = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.method === 'POST' && req.url === '/transaction/initialize') {
      paystackRequests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.com/test' } }));
    }
    if (req.method === 'GET' && req.url.startsWith('/transaction/verify/')) {
      const initialized = paystackRequests[0];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: true, data: {
        reference: initialized.reference, amount: initialized.amount, currency: initialized.currency,
        status: 'success', metadata: { service: 'SITE_B_PAYMENT_SERVICE', paymentServiceTransactionId: initialized.metadata.paymentServiceTransactionId }
      } }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: false, message: 'not found' }));
  });
  const paystackPort = await listen(paystack);
  const siteAPort = await new Promise(async resolve => {
    const server = http.createServer();
    await listen(server);
    const port = server.address().port;
    await new Promise(done => server.close(done));
    resolve(port);
  });
  const siteBPort = await new Promise(async resolve => {
    const server = http.createServer();
    await listen(server);
    const port = server.address().port;
    await new Promise(done => server.close(done));
    resolve(port);
  });
  const siteABase = `http://127.0.0.1:${siteAPort}`;
  const siteBBase = `http://127.0.0.1:${siteBPort}`;
  const siteA = spawn(process.execPath, ['server.js'], {
    cwd: SITE_A_ROOT,
    env: { ...process.env, PORT: String(siteAPort), APP_BASE_URL: siteABase, SITE_B_BASE_URL: siteBBase, SITE_A_TO_SITE_B_SECRET: INIT_SECRET, SITE_B_TO_SITE_A_SECRET: CALLBACK_SECRET, PHANTOM_DATA_FILE: siteAData },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let siteALogs = '';
  let siteBLogs = '';
  siteA.stdout.on('data', chunk => { siteALogs += chunk.toString(); });
  siteA.stderr.on('data', chunk => { siteALogs += chunk.toString(); });
  const siteB = spawn(process.execPath, ['server.js'], {
    cwd: SITE_B_ROOT,
    env: { ...process.env, PORT: String(siteBPort), SITE_B_BASE_URL: siteBBase, SITE_A_BASE_URL: siteABase, SITE_A_TO_SITE_B_SECRET: INIT_SECRET, SITE_B_TO_SITE_A_SECRET: CALLBACK_SECRET, PAYSTACK_SECRET_KEY: PAYSTACK_SECRET, PAYSTACK_TEST_SECRET_KEY: PAYSTACK_SECRET, PAYSTACK_API_BASE_URL: `http://127.0.0.1:${paystackPort}`, PAYMENT_DATA_FILE: siteBData, DATA_BUNDLE_DATA_FILE: path.join(tempDir, 'bundles.json'), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  siteB.stdout.on('data', chunk => { siteBLogs += chunk.toString(); });
  siteB.stderr.on('data', chunk => { siteBLogs += chunk.toString(); });
  t.after(async () => {
    await Promise.all([stop(siteA), stop(siteB)]);
    await new Promise(resolve => paystack.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  try { await Promise.all([waitForHealth(siteABase), waitForHealth(siteBBase)]); }
  catch (error) { throw new Error(`${error.message}\nSite A: ${siteALogs}\nSite B: ${siteBLogs}`); }

  const signupResponse = await fetch(`${siteABase}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'E2E User', phone: '0241234599', email: 'e2e-user@gmail.com', password: 'simple' }) });
  assert.equal(signupResponse.status, 201);
  const cookie = signupResponse.headers.get('set-cookie');
  const depositResponse = await fetch(`${siteABase}/api/deposits`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'e2e-wallet-topup-1' }, body: JSON.stringify({ amount: 180 }) });
  const deposit = await depositResponse.json();
  if (depositResponse.status !== 201) {
    const failedDb = JSON.parse(fs.readFileSync(siteAData, 'utf8'));
    const failedDeposit = failedDb.deposits[0];
    const lookupBody = JSON.stringify({ siteATransactionId: failedDeposit?.transactionId });
    const lookupTimestamp = String(Date.now());
    const lookupId = 'e2e-direct-lookup';
    const lookupSignature = crypto.createHmac('sha256', CALLBACK_SECRET).update(`${lookupTimestamp}.${lookupId}.${lookupBody}`).digest('hex');
    const lookupResponse = await fetch(`${siteABase}/api/v1/internal/topups/lookup`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${CALLBACK_SECRET}`, 'x-request-id': lookupId, 'x-timestamp': lookupTimestamp, 'x-sitea-signature': lookupSignature }, body: lookupBody });
    const lookupResult = await lookupResponse.text();
    const initPayload = { siteATransactionId: failedDeposit.transactionId, siteAUserId: failedDeposit.userId, amountMinor: failedDeposit.amountMinor, currency: failedDeposit.currency, customer: { email: failedDb.users[0].paystackPaymentEmail }, purpose: failedDeposit.purpose };
    const initBody = JSON.stringify(initPayload);
    const initTimestamp = String(Date.now());
    const initId = 'e2e-direct-init';
    const initSignature = crypto.createHmac('sha256', INIT_SECRET).update(`${initTimestamp}.${initId}.${initBody}`).digest('hex');
    const initResponse = await fetch(`${siteBBase}/api/v1/payments/initialize`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${INIT_SECRET}`, 'x-request-id': initId, 'x-timestamp': initTimestamp, 'x-sitea-signature': initSignature }, body: initBody });
    const initResult = await initResponse.text();
    await new Promise(resolve => setTimeout(resolve, 50));
    throw new Error(`deposit failed: ${JSON.stringify(deposit)}; direct lookup ${lookupResponse.status}: ${lookupResult}; direct init ${initResponse.status}: ${initResult}; paystack ${JSON.stringify(paystackRequests)}; siteB data ${fs.existsSync(siteBData) ? fs.readFileSync(siteBData, 'utf8') : 'missing'}\nSite A: ${siteALogs}\nSite B: ${siteBLogs}`);
  }
  assert.equal(deposit.authorizationUrl, undefined);
  assert.equal(deposit.paystackReference, undefined);
  assert.match(deposit.handoffUrl, new RegExp(`^${siteBBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/payment/handoff\\?token=`));
  assert.equal(paystackRequests.length, 1);
  assert.doesNotMatch(JSON.stringify(paystackRequests[0].metadata), /SITE_A|siteATransactionId|siteAUserId/);

  const handoff = await fetch(deposit.handoffUrl, { redirect: 'manual' });
  assert.equal(handoff.status, 302);
  assert.equal(handoff.headers.get('location'), 'https://checkout.paystack.com/test');
  const storedSiteB = JSON.parse(fs.readFileSync(siteBData, 'utf8')).transactions[0];
  const event = { id: 'evt_e2e_1', event: 'charge.success', data: { reference: storedSiteB.paystackReference, amount: storedSiteB.amountMinor, currency: storedSiteB.currency, status: 'success', metadata: { service: 'SITE_B_PAYMENT_SERVICE', paymentServiceTransactionId: storedSiteB.id } } };
  const raw = JSON.stringify(event);
  const signature = crypto.createHmac('sha512', PAYSTACK_SECRET).update(raw).digest('hex');
  const webhook = await fetch(`${siteBBase}/api/v1/webhooks/paystack`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': signature }, body: raw });
  assert.equal(webhook.status, 200);
  const savedSiteA = JSON.parse(fs.readFileSync(siteAData, 'utf8'));
  const savedDeposit = savedSiteA.deposits[0];
  assert.equal(savedDeposit.status, 'SUCCESS');
  assert.equal(savedSiteA.users[0].walletBalance, 180);
  assert.equal(savedSiteA.transactions.filter(item => item.reference === savedDeposit.reference && item.reason === 'Wallet top-up').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(siteBData, 'utf8')).transactions[0].status, 'SUCCESS');
});
