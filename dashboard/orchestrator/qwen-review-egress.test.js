'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {authorizeReviewRequest,createReviewRelay}=require('./qwen-review-egress');
const http=require('node:http');
const crypto=require('node:crypto');
const fake='a'.repeat(32);
const bodyHash=crypto.createHash('sha256').update('{}').digest('hex');
function request() {
  const headers={host:'review-relay:18888',authorization:'Bearer '+fake,'content-type':'application/json','content-length':'2'};
  return {method:'POST',url:'/v1/responses',httpVersion:'1.1',headers,rawHeaders:Object.entries(headers).flat()};
}
test('relay policy accepts only the fixed upstream operation',()=>{
  assert.deepEqual(authorizeReviewRequest(request(),fake),{host:'api.openai.com',port:443,path:'/v1/responses',method:'POST',contentLength:2});
  for(const mutate of [r=>r.method='CONNECT',r=>r.method='GET',r=>r.url='https://evil.invalid/v1/responses',r=>r.url='/v1/responses?redirect=1',r=>r.headers.host='evil.invalid',r=>r.headers.authorization='Bearer '+('b'.repeat(32)),r=>r.headers['content-length']='2097153',r=>r.rawHeaders.push('Host','evil.invalid'),r=>r.rawHeaders.push('Transfer-Encoding','chunked')]) {
    const r=request(); mutate(r); assert.throws(()=>authorizeReviewRequest(r,fake));
  }
});

test('live relay refuses other paths and injects a fixture token only into its fixed upstream', async t=>{
  let seen=0, receivedAuth='';
  const upstream=http.createServer((req,res)=>{seen++;receivedAuth=req.headers.authorization;req.resume();req.on('end',()=>res.writeHead(200,{'content-type':'application/json'}).end('{}'));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(()=>upstream.close());
  const relay=createReviewRelay({bearer:fake,expectedBodyHash:bodyHash,expiresAt:Date.now()+10000,getAccessToken:async()=> 'fixture-access-token',upstreamRequest:(options,cb)=>{
    assert.equal(options.hostname,'api.openai.com'); assert.equal(options.path,'/v1/responses'); assert.equal(options.rejectUnauthorized,true);
    return http.request({...options,hostname:'127.0.0.1',port:upstream.address().port},cb);
  }});
  await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
  t.after(()=>relay.close());
  const send=path=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:relay.address().port,path,method:'POST',headers:{host:'review-relay:18888',authorization:'Bearer '+fake,'content-type':'application/json','content-length':'2',connection:'close'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});
    req.on('error',reject);req.end('{}');
  });
  assert.equal((await send('/v1/responses?target=evil')).status,403); assert.equal(seen,0);
  const ok=await send('/v1/responses');
  assert.equal(ok.status,200); assert.equal(ok.body,'{}'); assert.equal(seen,1); assert.equal(receivedAuth,'Bearer fixture-access-token');
  assert.equal((await send('/v1/responses')).status,429); assert.equal(seen,1);
});

test('disconnect while token is pending never launches an upstream request', async t=>{
  let releaseToken,notifyStarted,notifyAborted,requests=0;
  const started=new Promise(resolve=>notifyStarted=resolve);
  const aborted=new Promise(resolve=>notifyAborted=resolve);
  const relay=createReviewRelay({bearer:fake,expectedBodyHash:bodyHash,expiresAt:Date.now()+10000,getAccessToken:({signal})=>{
    notifyStarted(); signal.addEventListener('abort',notifyAborted,{once:true});
    return new Promise(resolve=>releaseToken=resolve);
  },upstreamRequest:()=>{requests++;throw Error('must not run');}});
  await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve)); t.after(()=>relay.close());
  const req=http.request({hostname:'127.0.0.1',port:relay.address().port,path:'/v1/responses',method:'POST',headers:{host:'review-relay:18888',authorization:'Bearer '+fake,'content-type':'application/json','content-length':'2',connection:'close'}});
  req.on('error',()=>{});req.end('{}');
  await started; req.destroy(); await aborted;
  releaseToken('fixture-access-token');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests,0);
});

test('a changed request body is rejected before the token supplier runs', async t=>{
  let tokens=0;
  const relay=createReviewRelay({bearer:fake,expectedBodyHash:bodyHash,expiresAt:Date.now()+10000,getAccessToken:async()=>{tokens++;return 'fixture-token';}});
  await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve)); t.after(()=>relay.close());
  const status=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:relay.address().port,path:'/v1/responses',method:'POST',headers:{host:'review-relay:18888',authorization:'Bearer '+fake,'content-type':'application/json','content-length':'3',connection:'close'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end('{ }');
  });
  assert.equal(status,403);assert.equal(tokens,0);
});

test('session expiry while token is pending never launches an upstream request', async t=>{
  let requests=0;
  const relay=createReviewRelay({bearer:fake,expectedBodyHash:bodyHash,expiresAt:Date.now()+200,getAccessToken:()=>new Promise(resolve=>setTimeout(()=>resolve('fixture-token'),400)),upstreamRequest:()=>{requests++;throw Error('must not run');}});
  await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve)); t.after(()=>relay.close());
  const status=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:relay.address().port,path:'/v1/responses',method:'POST',headers:{host:'review-relay:18888',authorization:'Bearer '+fake,'content-type':'application/json','content-length':'2',connection:'close'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    req.on('error',reject);req.end('{}');
  });
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.ok([408,503].includes(status));assert.equal(requests,0);
});

test('session expiry closes a client that sends the body too slowly', async t=>{
  let requests=0;
  const relay=createReviewRelay({bearer:fake,expectedBodyHash:bodyHash,expiresAt:Date.now()+200,getAccessToken:async()=>{requests++;return 'fixture';}});
  await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));t.after(()=>relay.close());
  const outcome=await new Promise((resolve,reject)=>{
    const deadline=setTimeout(()=>reject(Error('socket remained open')),1500);
    const req=http.request({hostname:'127.0.0.1',port:relay.address().port,path:'/v1/responses',method:'POST',headers:{host:'review-relay:18888',authorization:'Bearer '+fake,'content-type':'application/json','content-length':'2',connection:'close'}},res=>{res.resume();res.on('end',()=>{clearTimeout(deadline);resolve('response');});});
    req.on('error',()=>{clearTimeout(deadline);resolve('closed');});req.write('{');
  });
  assert.ok(['response','closed'].includes(outcome));assert.equal(requests,0);
});
