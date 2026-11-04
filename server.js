const http=require('node:http'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),{Readable}=require('node:stream'),{PAYSTACK_PAYMENT_EMAILS,isAllowedPaystackPaymentEmail}=require('./payment-config'),ROOT=__dirname;
const { createBundleRoute, handleBundleWebhook } = require('./bundle-service');
const bundleRoute = createBundleRoute({
  getBase: () => normalizeBase(process.env.SITE_B_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4000}`),
  pay: (...args) => pay(...args)
});
function servePublicSite(r,pathname){
  const files={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'};
  const name=files[pathname];
  if(!name)return false;
  const file=path.join(ROOT,'public',name);
  if(!fs.existsSync(file))return false;
  const type=name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html';
  r.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':name==='index.html'||name==='app.js'?'no-cache':'public, max-age=300','x-content-type-options':'nosniff'});
  r.end(fs.readFileSync(file));
  return true;
}
const createHttpServer=http.createServer;
http.createServer=(handler)=>createHttpServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&servePublicSite(res,pathname))return;
  if(req.method==='POST'&&pathname==='/api/v1/webhooks/paystack'){
    const raw=await read(req);
    const handled=await handleBundleWebhook(raw,req.headers);
    if(handled){
      if(handled.duplicate){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true,duplicate:true}));}
      else{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({ok:true}));}
      return;
    }
    const replay=Readable.from([raw]);
    replay.method=req.method; replay.url=req.url; replay.headers=req.headers;
    return handler(replay,res);
  }
  if(req.method==='POST'&&pathname==='/api/v1/internal/admin/reconcile'){
    const raw=await read(req);
    return handleAdminReconciliation(req,res,raw);
  }
  await bundleRoute(req,res);
  if(res.writableEnded)return;
  return handler(req,res);
});
for(const l of(fs.existsSync(path.join(ROOT,'.env'))?fs.readFileSync(path.join(ROOT,'.env'),'utf8'):'').split(/\r?\n/)){const i=l.indexOf('=');if(i>0&&!l.trim().startsWith('#')&&process.env[l.slice(0,i).trim()]===undefined)process.env[l.slice(0,i).trim()]=l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')}
const cleanEnv=value=>String(value??'').trim().replace(/^(['"])(.*)\1$/,'$2').trim();
const normalizeBase=value=>cleanEnv(value).replace(/\/+$/,'');
const PORT=+cleanEnv(process.env.PORT)||4000,BASE=normalizeBase(process.env.SITE_B_BASE_URL||`http://127.0.0.1:${PORT}`),A=normalizeBase(process.env.SITE_A_BASE_URL),AB=cleanEnv(process.env.SITE_A_TO_SITE_B_SECRET),BA=cleanEnv(process.env.SITE_B_TO_SITE_A_SECRET),configuredPaystackKey=cleanEnv(process.env.PAYSTACK_SECRET_KEY),testPaystackKey=cleanEnv(process.env.PAYSTACK_TEST_SECRET_KEY),KEY=testPaystackKey||configuredPaystackKey,API=normalizeBase(process.env.PAYSTACK_API_BASE_URL||'https://api.paystack.co'),DATA=cleanEnv(process.env.PAYMENT_DATA_FILE)||path.join(ROOT,'data/payment-service.json'),PUBLIC_ROOT=path.join(ROOT,'public'),CALLBACK_RETRY_INTERVAL_MS=Math.max(10,Number(cleanEnv(process.env.CALLBACK_RETRY_INTERVAL_MS))||30000),CALLBACK_RETRY_INITIAL_DELAY_MS=Math.max(10,Number(cleanEnv(process.env.CALLBACK_RETRY_INITIAL_DELAY_MS))||30000),PAYMENT_RECONCILIATION_INTERVAL_MS=Math.max(10,Number(cleanEnv(process.env.PAYMENT_RECONCILIATION_INTERVAL_MS))||60000),REQUEST_ID_RETENTION_MS=10*60*1000;
const now=()=>new Date().toISOString();
const id=p=>`${p}_${crypto.randomBytes(12).toString('hex')}`;
const handoffToken=()=>crypto.randomBytes(32).toString('base64url');
const validHandoffToken=value=>/^[A-Za-z0-9_-]{16,256}$/.test(String(value||''));
const handoffUrl=token=>`${BASE}/payment/handoff?token=${encodeURIComponent(token)}`;
const validPaystackAuthorizationUrl=value=>{try{const u=new URL(String(value||''));return u.protocol==='https:'&&u.hostname==='checkout.paystack.com'&&!u.username&&!u.password&&!u.hash}catch{return false}};
const HANDOFF_ENCRYPTION_KEY=crypto.createHash('sha256').update(`site-b-handoff-token:${AB}`).digest();
const hashHandoffToken=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
function encryptHandoffToken(token){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',HANDOFF_ENCRYPTION_KEY,iv),encrypted=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decryptHandoffToken(value){
  try{
    const [ivText,tagText,cipherText]=String(value||'').split('.');
    if(!ivText||!tagText||!cipherText)return '';
    const decipher=crypto.createDecipheriv('aes-256-gcm',HANDOFF_ENCRYPTION_KEY,Buffer.from(ivText,'base64url'));
    decipher.setAuthTag(Buffer.from(tagText,'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(cipherText,'base64url')),decipher.final()]).toString('utf8');
  }catch{return ''}
}
function ensureHandoffToken(transaction,preferred=''){
  const decrypted=decryptHandoffToken(transaction.handoffTokenCiphertext);
  let token=validHandoffToken(preferred)?preferred:validHandoffToken(transaction.handoffToken)?transaction.handoffToken:validHandoffToken(decrypted)?decrypted:'';
  if(!token)token=handoffToken();
  const hash=hashHandoffToken(token);
  let changed=transaction.handoffTokenHash!==hash||'handoffToken' in transaction;
  if(!transaction.handoffTokenCiphertext||decrypted!==token){transaction.handoffTokenCiphertext=encryptHandoffToken(token);changed=true}
  transaction.handoffTokenHash=hash;
  delete transaction.handoffToken;
  return {token,changed};
}
function ensureResultToken(transaction,preferred=''){
  const decrypted=decryptHandoffToken(transaction.resultTokenCiphertext);
  let token=validHandoffToken(preferred)?preferred:validHandoffToken(decrypted)?decrypted:'';
  if(!token)token=handoffToken();
  const hash=hashHandoffToken(token);
  let changed=transaction.resultTokenHash!==hash;
  if(!transaction.resultTokenCiphertext||decrypted!==token){transaction.resultTokenCiphertext=encryptHandoffToken(token);changed=true}
  transaction.resultTokenHash=hash;
  return {token,changed};
}
const eq=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const read=async q=>{const c=[];for await(const x of q)c.push(x);return Buffer.concat(c)};

function validHttpBase(value){
  try{const u=new URL(String(value||''));return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash}
  catch{return false}
}
function configurationIssues(){
  const issues=[];
  if(!validHttpBase(BASE))issues.push('SITE_B_BASE_URL');
  if(!validHttpBase(A))issues.push('SITE_A_BASE_URL');
  if(!AB)issues.push('SITE_A_TO_SITE_B_SECRET');
  if(!BA)issues.push('SITE_B_TO_SITE_A_SECRET');
  if(!KEY)issues.push('PAYSTACK_SECRET_KEY');
  if(!validHttpBase(API))issues.push('PAYSTACK_API_BASE_URL');
  return issues;
}
function requestId(req){
  const supplied=String(req.headers?.['x-request-id']||'');
  return /^[A-Za-z0-9_-]{8,200}$/.test(supplied)?supplied:id('req');
}
function paymentError(res,status,code,message,correlationId){
  return out(res,status,{error:message,code,requestId:correlationId});
}
function logPaymentFailure(fields){
  const safe={event:'payment_failure',...fields};
  delete safe.authorizationUrl;
  delete safe.paystackReference;
  console.error('[payment-service]',JSON.stringify(safe));
}

function load(){
  fs.mkdirSync(path.dirname(DATA),{recursive:true});
  if(!fs.existsSync(DATA))return{transactions:[],webhookEvents:[],requestIds:[]};
  const d=JSON.parse(fs.readFileSync(DATA));
  return{transactions:d.transactions||[],webhookEvents:d.webhookEvents||[],requestIds:d.requestIds||[]};
}
function save(d){
  const directory=path.dirname(DATA),temporary=path.join(directory,`.${path.basename(DATA)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.mkdirSync(directory,{recursive:true});
  try{fs.writeFileSync(temporary,JSON.stringify(d,null,2),{mode:0o600});fs.renameSync(temporary,DATA)}
  finally{if(fs.existsSync(temporary))fs.rmSync(temporary,{force:true})}
}
function out(r,s,x){r.writeHead(s,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});r.end(JSON.stringify(x))}

function signed(s,p,r=id('req')){
  const t=String(Date.now()),b=JSON.stringify(p);
  return{authorization:`Bearer ${s}`,'x-request-id':r,'x-timestamp':t,'x-sitea-signature':crypto.createHmac('sha256',s).update(`${t}.${r}.${b}`).digest('hex')};
}
function auth(q,b,s){
  const r=String(q.headers['x-request-id']||''),t=String(q.headers['x-timestamp']||''),g=String(q.headers['x-sitea-signature']||''),bearer=String(q.headers.authorization||'').replace(/^Bearer\s+/i,'');
  return !!(s&&eq(bearer,s)&&/^[A-Za-z0-9_-]{8,200}$/.test(r)&&/^\d{13}$/.test(t)&&/^[a-f0-9]{64}$/i.test(g)&&Math.abs(Date.now()- +t)<=300000&&eq(g,crypto.createHmac('sha256',s).update(`${t}.${r}.${b}`).digest('hex')));
}
function claimRequestId(d,requestId){
  const cutoff=Date.now()-REQUEST_ID_RETENTION_MS;
  d.requestIds=(d.requestIds||[]).filter(item=>{
    const usedAt=typeof item==='string'?0:Date.parse(item.usedAt||item.createdAt||'');
    return Number.isFinite(usedAt)&&usedAt>=cutoff;
  });
  if(d.requestIds.some(item=>(typeof item==='string'?item:item.requestId)===requestId))return false;
  d.requestIds.push({requestId,usedAt:now()});
  save(d);
  return true;
}
function valid(p){return p&&/^[A-Za-z0-9_-]{8,160}$/.test(p.siteATransactionId)&&/^[A-Za-z0-9_-]{8,160}$/.test(p.siteAUserId)&&Number.isInteger(p.amountMinor)&&p.amountMinor>0&&/^[A-Z]{3}$/.test(p.currency)&&['WALLET_TOPUP','KYC_BYPASS'].includes(p.purpose)&&isAllowedPaystackPaymentEmail(p.customer?.email)}
function validAdminReconciliation(p){
  return p&&/^[A-Za-z0-9_-]{8,160}$/.test(String(p.siteATransactionId||''))
    &&(p.paystackReference===undefined||p.paystackReference===null||/^[A-Za-z0-9_-]{8,160}$/.test(String(p.paystackReference)));
}
async function call(pathname,p){
  const r=await fetch(A+pathname,{method:'POST',headers:{'content-type':'application/json',...signed(BA,p)},body:JSON.stringify(p)}),d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.error||'Site A rejected request');
  return d;
}
async function pay(route,o={}){
  if(!KEY)throw Error('Payment service is not configured');
  const r=await fetch(API+route,{...o,headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json',...(o.headers||{})}}),d=await r.json();
  if(!r.ok||!d.status)throw Error(d.message||'Paystack request failed');
  return d.data;
}
async function initializeProviderPayment(d,t,correlationId=''){
  t.status='INITIALIZING';
  t.initializationAttempts=Number(t.initializationAttempts||0)+1;
  t.lastInitializationAttemptAt=now();
  t.updatedAt=now();
  const result=ensureResultToken(t);
  save(d);
  try{
    const c=await pay('/transaction/initialize',{method:'POST',body:JSON.stringify({email:t.customerEmail,amount:t.amountMinor,currency:t.currency,reference:t.paystackReference,callback_url:BASE+'/payment/return?token='+encodeURIComponent(result.token),metadata:{service:'SITE_B_PAYMENT_SERVICE',paymentServiceTransactionId:t.id}})});
    if(!validPaystackAuthorizationUrl(c.authorization_url))throw Error('Payment provider returned an invalid authorization URL.');
    t.authorizationUrl=c.authorization_url;
    t.status='PENDING';
    t.initializedAt=now();
    t.initializationLastError=null;
    t.updatedAt=now();
    save(d);
    return c;
  }catch(error){
    t.initializationLastError=String(error?.message||'Payment initialization failed').slice(0,240);
    t.updatedAt=now();
    save(d);
    logPaymentFailure({code:'PAYSTACK_INITIALIZATION_FAILED',requestId:correlationId||undefined,transactionId:t.id,attempts:t.initializationAttempts,message:t.initializationLastError});
    throw error;
  }
}
function match(t,p){
  const m=p.metadata||{};
  const siteBMetadata=m.service==='SITE_B_PAYMENT_SERVICE'
    &&m.paymentServiceTransactionId===t.id;
  const legacySiteAMetadata=m.site==='SITE_A'
    &&m.siteATransactionId===t.siteATransactionId
    &&m.siteAUserId===t.siteAUserId
    &&m.purpose===t.purpose;
  return p.reference===t.paystackReference
    &&p.amount===t.amountMinor
    &&p.currency===t.currency
    &&(siteBMetadata||legacySiteAMetadata);
}
function adminStatus(t,p){
  if(p.status==='success')return 'SUCCESS';
  if(['failed','abandoned','reversed'].includes(p.status))return 'FAILED';
  return Date.parse(t.expiresAt)<=Date.now()?'EXPIRED':'PENDING';
}
function adminResult(t,p,callbackDelivered){
  return{ok:true,transactionId:t.id,siteATransactionId:t.siteATransactionId,paystackReference:t.paystackReference,status:t.status,paystackStatus:String(p.status||''),callbackDelivered,amountMinor:t.amountMinor,currency:t.currency};
}
function servePublic(r,pathname){const files={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'},name=files[pathname];if(!name)return false;const file=path.join(PUBLIC_ROOT,name);if(!fs.existsSync(file))return false;const type=name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html';r.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':name==='index.html'?'no-cache':'public, max-age=300','x-content-type-options':'nosniff'});r.end(fs.readFileSync(file));return true}
const terminalPaymentStatuses=new Set(['SUCCESS','FAILED','EXPIRED']);
function callbackDelivered(t){
  const delivery=t.callbackDelivery;
  if(delivery)return delivery.status===t.status&&Boolean(delivery.deliveredAt);
  return Boolean(t.callbackDeliveredAt);
}
function callbackDue(t){
  if(!terminalPaymentStatuses.has(t.status)||callbackDelivered(t))return false;
  const nextAttemptAt=Date.parse(t.callbackDelivery?.nextAttemptAt||'');
  return !Number.isFinite(nextAttemptAt)||nextAttemptAt<=Date.now();
}
function callbackRetryDelay(attempts){
  const delays=[CALLBACK_RETRY_INITIAL_DELAY_MS,CALLBACK_RETRY_INITIAL_DELAY_MS*2,CALLBACK_RETRY_INITIAL_DELAY_MS*10,CALLBACK_RETRY_INITIAL_DELAY_MS*60];
  return delays[Math.min(Math.max(Number(attempts||1)-1,0),delays.length-1)];
}
async function notify(d,t,source='',force=false){
  if(!force&&!callbackDue(t))return callbackDelivered(t);
  const previous=t.callbackDelivery?.status===t.status?t.callbackDelivery:{};
  const delivery={...previous,status:t.status,attempts:Number(previous.attempts||0)+1,lastAttemptAt:now(),nextAttemptAt:null,lastError:null,source:source||previous.source||'payment-service'};
  t.callbackDelivery=delivery;
  t.callbackAttempts=delivery.attempts;
  t.lastCallbackAt=delivery.lastAttemptAt;
  t.callbackAttemptedAt=delivery.lastAttemptAt;
  save(d);
  const prefix=t.purpose==='KYC_BYPASS'?'kyc_bypass':'wallet_topup',event=t.status==='SUCCESS'?`${prefix}.success`:t.status==='EXPIRED'?`${prefix}.expired`:`${prefix}.failed`,endpoint=t.purpose==='KYC_BYPASS'?'/api/v1/webhooks/kyc-bypass-payment-status':'/api/v1/webhooks/payment-status';
  try{
    await call(endpoint,{event,siteATransactionId:t.siteATransactionId,siteAUserId:t.siteAUserId,amountMinor:t.amountMinor,currency:t.currency,purpose:t.purpose,paystackReference:t.paystackReference,paymentServiceTransactionId:t.id,status:t.status,...(source?{source}:{}),timestamp:now()});
    delivery.deliveredAt=now();
    delivery.nextAttemptAt=null;
    delivery.lastError=null;
    t.callbackDeliveredAt=delivery.deliveredAt;
    t.callbackDeliveredStatus=t.status;
    save(d);
    return true;
  }catch(error){
    delivery.lastError=String(error?.message||'Site A callback failed').slice(0,240);
    delivery.nextAttemptAt=new Date(Date.now()+callbackRetryDelay(delivery.attempts)).toISOString();
    t.callbackLastError=delivery.lastError;
    save(d);
    return false;
  }
}
async function reconcile(d,t,source='payment-verification'){
  const p=await pay('/transaction/verify/'+encodeURIComponent(t.paystackReference));
  if(!match(t,p))throw Error('Payment mismatch');
  if(p.status==='success')t.status='SUCCESS';
  else if(['failed','abandoned','reversed'].includes(p.status))t.status='FAILED';
  else if(['PENDING','INITIALIZING'].includes(t.status))t.status=Date.parse(t.expiresAt)<=Date.now()?'EXPIRED':'PENDING';
  t.updatedAt=now();
  if(t.status==='SUCCESS')t.paidAt=t.paidAt||now();
  if(terminalPaymentStatuses.has(t.status)&&!callbackDelivered(t))await notify(d,t,source);
  save(d);
}

let paymentStateTail=Promise.resolve();
async function withPaymentStateLock(work){
  const previous=paymentStateTail;
  let release;
  const current=new Promise(resolve=>{release=resolve});
  paymentStateTail=current;
  await previous;
  try{return await work()}finally{release()}
}
const paymentTransactionLocks=new Map();
async function withPaymentTransactionLock(key,work){
  const previous=paymentTransactionLocks.get(key)||Promise.resolve();
  let release;
  const current=new Promise(resolve=>{release=resolve});
  paymentTransactionLocks.set(key,current);
  await previous;
  try{return await withPaymentStateLock(work)}finally{release();if(paymentTransactionLocks.get(key)===current)paymentTransactionLocks.delete(key)}
}
async function withAdminReconciliationLock(key,work){return withPaymentTransactionLock(key,work)}
async function withPaymentInitializationLock(key,work){
  return withPaymentTransactionLock(key,work);
}
async function retryPendingCallbacks(){
  const ids=load().transactions.filter(callbackDue).map(t=>t.id);
  for(const transactionId of ids){
    const snapshot=load(),item=snapshot.transactions.find(t=>t.id===transactionId);
    if(!item)continue;
    await withPaymentTransactionLock(item.siteATransactionId,async()=>{
      const d=load(),t=d.transactions.find(transaction=>transaction.id===transactionId);
      if(t&&callbackDue(t))await notify(d,t,'callback-retry');
    });
  }
}
async function reconcilePendingPayments(){
  const ids=load().transactions.filter(t=>['PENDING','INITIALIZING'].includes(t.status)||(terminalPaymentStatuses.has(t.status)&&!callbackDelivered(t))).map(t=>t.id);
  for(const transactionId of ids){
    const snapshot=load(),item=snapshot.transactions.find(t=>t.id===transactionId);
    if(!item)continue;
    await withPaymentTransactionLock(item.siteATransactionId,async()=>{
      const d=load(),t=d.transactions.find(transaction=>transaction.id===transactionId);
      if(!t||(!['PENDING','INITIALIZING'].includes(t.status)&&!(terminalPaymentStatuses.has(t.status)&&!callbackDelivered(t))))return;
      try{
        const p=await pay('/transaction/verify/'+encodeURIComponent(t.paystackReference));
        if(!match(t,p))return;
        if(p.status==='success')t.status='SUCCESS';
        else if(['failed','abandoned','reversed'].includes(p.status))t.status='FAILED';
        else if(['PENDING','INITIALIZING'].includes(t.status)&&Date.parse(t.expiresAt)<=Date.now())t.status='EXPIRED';
        else if(!terminalPaymentStatuses.has(t.status))return;
        t.updatedAt=now();
        if(t.status==='SUCCESS')t.paidAt=t.paidAt||now();
        save(d);
        if(!callbackDelivered(t))await notify(d,t,'scheduled-reconciliation');
      }catch{}
    });
  }
}
async function handleAdminReconciliation(req,res,raw){
  if(!auth(req,raw,AB))return out(res,401,{error:'Invalid Site A authentication.'});
  let input;
  try{input=JSON.parse(raw.toString('utf8'))}catch{return out(res,400,{error:'Malformed reconciliation request.'})}
  if(!validAdminReconciliation(input))return out(res,400,{error:'Malformed reconciliation request.'});

  return withAdminReconciliationLock(input.siteATransactionId,async()=>{
    const d=load();
    if(!claimRequestId(d,String(req.headers['x-request-id']||'')))return out(res,409,{error:'Request has already been used.'});
    const t=d.transactions.find(item=>item.siteATransactionId===input.siteATransactionId);
    if(!t)return out(res,404,{error:'Payment transaction was not found.'});
    if(input.paystackReference!==undefined&&input.paystackReference!==null&&input.paystackReference!==t.paystackReference){
      return out(res,409,{error:'Paystack reference does not match the Site B transaction.'});
    }

    let payment;
    try{payment=await pay('/transaction/verify/'+encodeURIComponent(t.paystackReference))}
    catch(error){return out(res,502,{error:`Paystack verification failed: ${error.message||'request failed'}`})}
    if(!match(t,payment))return out(res,409,{error:'Paystack transaction did not match the stored reference, amount, currency, metadata, or Site A transaction data.'});

    t.status=adminStatus(t,payment);
    t.updatedAt=now();
    if(t.status==='SUCCESS')t.paidAt=t.paidAt||now();
    save(d);

    let callbackDelivered=false;
    if(t.status!=='PENDING'){
      const previous=t.adminReconciliation||{};
      const alreadyDelivered=previous.status===t.status&&previous.paystackReference===t.paystackReference&&previous.callbackDeliveredAt;
      if(alreadyDelivered){
        callbackDelivered=true;
      }else{
        t.adminReconciliation={status:t.status,paystackReference:t.paystackReference,callbackAttemptedAt:now(),callbackDeliveredAt:null};
        save(d);
        callbackDelivered=await notify(d,t,'admin-reconciliation',true);
        if(callbackDelivered)t.adminReconciliation.callbackDeliveredAt=t.callbackDeliveredAt;
        if(!callbackDelivered){
          save(d);
          return out(res,502,{...adminResult(t,payment,false),ok:false,error:'Site A callback was queued for retry.'});
        }
      }
    }
    save(d);
    return out(res,200,adminResult(t,payment,callbackDelivered));
  });
}
function page(t,token){const safeToken=String(token).replace(/[^A-Za-z0-9_-]/g,'');return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Payment confirmation</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f5f8;color:#16212b;font:16px system-ui}.box{width:min(420px,calc(100% - 42px));background:#fff;border:1px solid #dbe2e8;border-radius:18px;padding:34px}h1{font-size:12px;letter-spacing:.16em;color:#64748b}h2{font-size:27px;margin:.3em 0}p{line-height:1.55;color:#52616e}button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:9px;background:#164e63;color:#fff;font-weight:700;font-size:16px}.note{font-size:13px}</style><main class=box><h1>SECURE PAYMENT</h1><h2>Payment confirmation</h2><p>Your payment status is being confirmed securely. You may close this window after the result appears.</p><button id=done>Check payment status</button><p class=note id=msg></p></main><script>const token=${JSON.stringify(safeToken)};done.onclick=async()=>{done.disabled=true;msg.textContent='Checking payment status…';try{let r=await fetch('/api/v1/payments/complete?token='+encodeURIComponent(token),{method:'POST'}),d=await r.json();msg.textContent=d.message||'Payment is still being confirmed.';if(d.status==='SUCCESS')msg.textContent='Payment confirmed successfully.';if(d.status==='FAILED'||d.status==='EXPIRED')msg.textContent='Payment was not completed.'}catch{msg.textContent='We could not check the payment right now.'}done.disabled=false};done.click()</script>`}
async function route(q,r){
  const u=new URL(q.url,BASE),d=load(),correlationId=requestId(q);
  try{
    if(q.method==='GET'&&u.pathname==='/api/health')return out(r,200,{ok:true,paystackConfigured:!!KEY,configurationValid:configurationIssues().length===0,paystackMode:KEY&&/^sk_test_/.test(KEY)?'test':KEY?'live':'unconfigured'});

    if(q.method==='GET'&&u.pathname==='/payment/handoff'){
      const keys=[...u.searchParams.keys()],token=u.searchParams.get('token')||'';
      if(keys.length!==1||keys[0]!=='token'||u.username||u.password||u.hash||!validHandoffToken(token))return out(r,400,{error:'Invalid payment handoff.'});
      let t=d.transactions.find(item=>item.handoffTokenHash===hashHandoffToken(token));
      if(!t)t=d.transactions.find(item=>item.handoffToken===token);
      if(!t)return out(r,404,{error:'Payment handoff was not found.'});
      return withPaymentTransactionLock(t.siteATransactionId,async()=>{
        const current=load();
        t=current.transactions.find(item=>item.handoffTokenHash===hashHandoffToken(token));
        if(!t)t=current.transactions.find(item=>item.handoffToken===token);
        if(!t)return out(r,404,{error:'Payment handoff was not found.'});
        const handoff=ensureHandoffToken(t,token);
        if(handoff.changed)save(current);
        const expiresAt=Date.parse(t.expiresAt);
        if(t.handoffUsedAt)return out(r,410,{error:'Payment handoff has already been used.'});
        if(t.status!=='PENDING'||!Number.isFinite(expiresAt)||expiresAt<=Date.now()){
          if(t.status==='PENDING'&&(!Number.isFinite(expiresAt)||expiresAt<=Date.now())){t.status='EXPIRED';t.updatedAt=now();save(current)}
          if(terminalPaymentStatuses.has(t.status)&&!callbackDelivered(t))await notify(current,t,'handoff-status');
          return out(r,410,{error:'Payment handoff has expired.'});
        }
        if(!validPaystackAuthorizationUrl(t.authorizationUrl))return out(r,409,{error:'Payment handoff is not ready.'});
        t.handoffUsedAt=now();
        t.updatedAt=now();
        save(current);
        r.writeHead(302,{'location':t.authorizationUrl,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
        return r.end();
      });
    }

    if(q.method==='GET'&&(u.pathname==='/payment/return'||u.pathname==='/payment/result')){
      const token=u.searchParams.get('token')||'';
      if(!validHandoffToken(token))return out(r,400,{error:'Invalid payment result.'});
      const t=d.transactions.find(item=>item.resultTokenHash===hashHandoffToken(token));
      if(!t)return out(r,404,{error:'Payment result was not found.'});
      if(u.pathname==='/payment/return'){
        r.writeHead(303,{'location':`${BASE}/payment/result?token=${encodeURIComponent(token)}`,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
        return r.end();
      }
      r.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
      return r.end(page(t,token));
    }

    if(q.method==='POST'&&u.pathname==='/api/v1/payments/initialize'){
      const b=await read(q);
      const issues=configurationIssues();
      if(issues.length)return paymentError(r,503,'PAYMENT_SERVICE_NOT_CONFIGURED','Secure payment checkout is not configured.',correlationId);
      if(!auth(q,b,AB))return out(r,401,{error:'Invalid Site A authentication.'});
      let p;
      try{p=JSON.parse(b)}catch{return out(r,400,{error:'Malformed request.'})}
      if(!valid(p))return out(r,400,{error:'Malformed payment request.'});
      return withPaymentInitializationLock(p.siteATransactionId,async()=>{
        const current=load();
        if(!claimRequestId(current,String(q.headers['x-request-id']||'')))return out(r,409,{error:'Request has already been used.'});
        let t=current.transactions.find(x=>x.siteATransactionId===p.siteATransactionId&&x.purpose===p.purpose);
        if(t){
          if(t.status==='INITIALIZING'&&Date.parse(t.expiresAt)>Date.now()){
            try{await initializeProviderPayment(current,t,correlationId)}
            catch{return paymentError(r,502,'PAYSTACK_INITIALIZATION_FAILED','Payment checkout could not be initialized. Your payment attempt was preserved for recovery.',correlationId)}
          }
          const expiresAt=Date.parse(t.expiresAt);
          if(t.status!=='PENDING'||!Number.isFinite(expiresAt)||expiresAt<=Date.now()){
            if(t.status==='PENDING'&&(!Number.isFinite(expiresAt)||expiresAt<=Date.now())){t.status='EXPIRED';t.updatedAt=now();save(current)}
            return out(r,409,{error:'Payment session is no longer active.'});
          }
          if(!validPaystackAuthorizationUrl(t.authorizationUrl)){
            try{await initializeProviderPayment(current,t,correlationId)}
            catch{return paymentError(r,502,'PAYSTACK_INITIALIZATION_FAILED','Payment checkout could not be initialized. Your payment attempt was preserved for recovery.',correlationId)}
          }
          const handoff=ensureHandoffToken(t);
          if(handoff.changed)save(current);
          return out(r,200,{transactionId:t.id,handoffUrl:handoffUrl(handoff.token),expiresAt:t.expiresAt});
        }
        const lookup=p.purpose==='KYC_BYPASS'?'/api/v1/internal/kyc-bypass/lookup':'/api/v1/internal/topups/lookup';
        let a;
        try{a=await call(lookup,{siteATransactionId:p.siteATransactionId})}
        catch(error){
          logPaymentFailure({code:'SITE_A_LOOKUP_FAILED',requestId:correlationId,message:String(error?.message||'Site A lookup failed').slice(0,240)});
          return paymentError(r,502,'SITE_A_LOOKUP_FAILED','Payment details could not be validated. Your payment attempt remains available for recovery.',correlationId);
        }
        if(a.userId!==p.siteAUserId||a.amountMinor!==p.amountMinor||a.currency!==p.currency||a.purpose!==p.purpose||!PAYSTACK_PAYMENT_EMAILS.includes(String(a.customer?.email||'').trim().toLowerCase())||String(a.customer.email||'').toLowerCase()!==p.customer.email.toLowerCase())return paymentError(r,409,'PAYMENT_DATA_MISMATCH','Payment details did not reconcile.',correlationId);
        t={id:id('pay'),siteATransactionId:p.siteATransactionId,siteAUserId:p.siteAUserId,amountMinor:p.amountMinor,currency:p.currency,purpose:p.purpose,paystackReference:'SBP_'+crypto.randomBytes(16).toString('hex'),status:'INITIALIZING',expiresAt:a.expiresAt,createdAt:now(),updatedAt:now(),customerEmail:p.customer.email};
        const handoff=ensureHandoffToken(t);
        current.transactions.push(t);
        save(current);
        try{await initializeProviderPayment(current,t,correlationId)}
        catch{return paymentError(r,502,'PAYSTACK_INITIALIZATION_FAILED','Payment checkout could not be initialized. Your payment attempt was preserved for recovery.',correlationId)}
        return out(r,201,{transactionId:t.id,handoffUrl:handoffUrl(handoff.token),expiresAt:t.expiresAt});
      });
    }

    if(q.method==='POST'&&u.pathname==='/api/v1/webhooks/paystack'){
      const b=await read(q),sig=q.headers['x-paystack-signature']||'',expected=KEY&&crypto.createHmac('sha512',KEY).update(b).digest('hex');
      if(!expected||!eq(sig,expected))return out(r,401,{error:'Invalid Paystack signature.'});
      const e=JSON.parse(b),eventId=String(e.id||crypto.createHash('sha256').update(b).digest('hex'));
      if(d.webhookEvents.some(x=>x.eventId===eventId))return out(r,200,{ok:true,duplicate:true});
      const p=e.data||{},t=d.transactions.find(x=>x.paystackReference===p.reference);
      if(!t)return withPaymentStateLock(async()=>{
        const current=load();
        if(current.webhookEvents.some(x=>x.eventId===eventId))return out(r,200,{ok:true,duplicate:true});
        current.webhookEvents.push({id:id('evt'),provider:'paystack',eventId,eventType:e.event,transactionReference:p.reference||'',payloadHash:crypto.createHash('sha256').update(b).digest('hex'),processed:false,receivedAt:now()});
        save(current);
        return out(r,200,{ok:true});
      });
      return withPaymentTransactionLock(t.siteATransactionId,async()=>{
        const current=load();
        if(current.webhookEvents.some(x=>x.eventId===eventId))return out(r,200,{ok:true,duplicate:true});
        const currentTransaction=current.transactions.find(x=>x.paystackReference===p.reference);
        current.webhookEvents.push({id:id('evt'),provider:'paystack',eventId,eventType:e.event,transactionReference:p.reference||'',payloadHash:crypto.createHash('sha256').update(b).digest('hex'),processed:false,receivedAt:now()});
        if(currentTransaction&&match(currentTransaction,p)){
          const previousStatus=currentTransaction.status;
          if(e.event==='charge.success')currentTransaction.status='SUCCESS';
          else if(e.event==='charge.failed')currentTransaction.status='FAILED';
          currentTransaction.updatedAt=now();
          if(currentTransaction.status==='SUCCESS')currentTransaction.paidAt=currentTransaction.paidAt||now();
          save(current);
          if(currentTransaction.status!=='PENDING'&&(previousStatus!==currentTransaction.status||!callbackDelivered(currentTransaction)))await notify(current,currentTransaction,'paystack-webhook',previousStatus!==currentTransaction.status);
          current.webhookEvents.at(-1).processed=true;
          current.webhookEvents.at(-1).processedAt=now();
        }
        save(current);
        return out(r,200,{ok:true});
      });
    }

    if(q.method==='POST'&&u.pathname==='/api/v1/payments/complete'){
      const token=u.searchParams.get('token')||'';
      if(!validHandoffToken(token))return out(r,400,{error:'Invalid payment result.'});
      const t=d.transactions.find(x=>x.resultTokenHash===hashHandoffToken(token));
      if(!t)return out(r,404,{error:'Payment result was not found.'});
      return withPaymentTransactionLock(t.siteATransactionId,async()=>{
        const current=load(),payment=current.transactions.find(x=>x.resultTokenHash===hashHandoffToken(token));
        if(!payment)return out(r,404,{error:'Payment session was not found.'});
        try{await reconcile(current,payment)}catch(error){
          logPaymentFailure({code:'PAYMENT_RECONCILIATION_FAILED',requestId:correlationId,transactionId:payment.id,message:String(error?.message||'Payment verification failed').slice(0,240)});
          return paymentError(r,502,'PAYMENT_RECONCILIATION_FAILED','Payment status could not be confirmed yet. Please try again shortly.',correlationId);
        }
        if(payment.status==='SUCCESS'&&callbackDelivered(payment))return out(r,200,{status:'SUCCESS',message:'Payment confirmed successfully.'});
        if(payment.status==='FAILED')return out(r,200,{status:'FAILED',message:'Payment was not completed.'});
        if(payment.status==='EXPIRED')return out(r,200,{status:'EXPIRED',message:'Payment session expired.'});
        return out(r,202,{status:'PENDING',message:'Payment is still being confirmed. Please try again shortly.'});
      });
    }
    return out(r,404,{error:'Not found.'});
  }catch(e){
    logPaymentFailure({code:'PAYMENT_SERVICE_INTERNAL_ERROR',requestId:correlationId,message:String(e?.message||'internal error').slice(0,240)});
    paymentError(r,500,'PAYMENT_SERVICE_INTERNAL_ERROR','Payment service could not process this request.',correlationId);
  }
}
const callbackRetryTimer=setInterval(()=>{retryPendingCallbacks().catch(()=>{})},CALLBACK_RETRY_INTERVAL_MS);
const paymentReconciliationTimer=setInterval(()=>{reconcilePendingPayments().catch(()=>{})},PAYMENT_RECONCILIATION_INTERVAL_MS);
callbackRetryTimer.unref();
paymentReconciliationTimer.unref();
http.createServer(route).listen(PORT,()=>console.log('Payment service: '+BASE));
