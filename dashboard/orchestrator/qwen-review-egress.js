'use strict';

// Request policy for a future trusted relay. It does not open a network socket,
// receive an OAuth token, or authorize a Docker reviewer on its own.
const crypto=require('node:crypto');
const http=require('node:http');
const https=require('node:https');

function authorizeReviewRequest(req, expectedBearer) {
  if (!req || typeof expectedBearer!=='string' || expectedBearer.length<32 || expectedBearer.length>256) throw Error('Invalid relay configuration');
  if (req.method!=='POST' || req.url!=='/v1/responses' || req.httpVersion!=='1.1') throw Error('Relay request refused');
  const headers=req.headers;
  if (!headers || typeof headers!=='object' || Array.isArray(headers)) throw Error('Relay request refused');
  const allowed=new Set(['host','authorization','content-type','content-length','accept','connection']);
  if (!Array.isArray(req.rawHeaders) || req.rawHeaders.length%2!==0) throw Error('Relay request refused');
  const seen=new Set();
  for(let i=0;i<req.rawHeaders.length;i+=2) {
    if(typeof req.rawHeaders[i]!=='string' || typeof req.rawHeaders[i+1]!=='string') throw Error('Relay request refused');
    const key=req.rawHeaders[i].toLowerCase();
    if(!allowed.has(key) || seen.has(key) || headers[key]!==req.rawHeaders[i+1]) throw Error('Relay request refused');
    seen.add(key);
  }
  if (Object.keys(headers).some(k=>!allowed.has(k) || !seen.has(k))) throw Error('Relay request refused');
  if (headers.host!=='review-relay:18888' || headers['content-type']!=='application/json' ||
      (headers.connection!==undefined && headers.connection.toLowerCase()!=='close') ||
      (headers.accept!==undefined && !['application/json','text/event-stream','*/*'].includes(headers.accept))) throw Error('Relay request refused');
  const length=headers['content-length'];
  if (typeof length!=='string' || !/^(0|[1-9][0-9]{0,6})$/.test(length) || Number(length)>2097152 || Number(length)<2) throw Error('Relay request refused');
  const actual=Buffer.from(typeof headers.authorization==='string' ? headers.authorization : '');
  const expected=Buffer.from('Bearer '+expectedBearer);
  if(actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected)) throw Error('Relay request refused');
  // The eventual forwarding code must use this fixed upstream, disable
  // redirects, verify TLS, bound streaming, and inject credentials itself.
  return {host:'api.openai.com',port:443,path:'/v1/responses',method:'POST',contentLength:Number(length)};
}

// Prototype only: caller must provide a trusted token supplier, bind this
// server to a verified isolated interface, and manage its complete lifecycle.
// No router or autonomous worker currently invokes this function.
function createReviewRelay({bearer, getAccessToken, expectedBodyHash, expiresAt, upstreamRequest=https.request}={}) {
  if(typeof getAccessToken!=='function' || typeof upstreamRequest!=='function' || !/^[a-f0-9]{64}$/.test(expectedBodyHash || '') ||
     !Number.isFinite(expiresAt) || expiresAt<=Date.now() || expiresAt>Date.now()+120000) throw Error('Invalid relay configuration');
  let active=false, used=false;
  const server=http.createServer((req,res)=>{
    let allowed;
    try { allowed=authorizeReviewRequest(req,bearer); } catch { res.writeHead(403,{'connection':'close'}).end(); return; }
    if(Date.now()>expiresAt || active || used) { res.writeHead(429,{'connection':'close'}).end(); return; }
    active=true; used=true;
    const controller=new AbortController();
    const sessionDeadline=setTimeout(()=>{
      controller.abort();
      if(!res.destroyed) { if(!res.headersSent)res.writeHead(408,{'connection':'close'}).end(); else res.destroy(); }
      req.destroy();
    },Math.max(0,expiresAt-Date.now()));
    res.once('close',()=>{clearTimeout(sessionDeadline);controller.abort();});
    let released=false, count=0, chunks=[];
    const release=()=>{if(!released){released=true;active=false;}};
    res.once('close',release);
    req.setTimeout(10000,()=>req.destroy());
    req.on('data',chunk=>{count+=chunk.length;if(count>allowed.contentLength || count>2097152) req.destroy();else chunks.push(chunk);});
    req.on('error',()=>{chunks=[];release();});
    req.on('end',async()=>{
      if(count!==allowed.contentLength){chunks=[];res.writeHead(400,{'connection':'close'}).end();return;}
      if(res.destroyed || req.aborted || controller.signal.aborted) {chunks=[];release();return;}
      if(Date.now()>expiresAt || crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')!==expectedBodyHash) {chunks=[];res.writeHead(403,{'connection':'close'}).end();return;}
      let token;
      const tokenDeadline=setTimeout(()=>controller.abort(),5000);
      try {
        token=await Promise.race([
          getAccessToken({signal:controller.signal}),
          new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true})),
        ]);
      } catch { chunks=[];if(!res.destroyed)res.writeHead(503,{'connection':'close'}).end();return; }
      finally { clearTimeout(tokenDeadline); }
      if(res.destroyed || req.aborted || controller.signal.aborted || Date.now()>=expiresAt) {chunks=[];token=null;if(!res.destroyed)res.writeHead(503,{'connection':'close'}).end();release();return;}
      if(typeof token!=='string' || !token || token.includes('\r') || token.includes('\n')) {chunks=[];res.writeHead(503,{'connection':'close'}).end();return;}
      let upstream;
      try {
        upstream=upstreamRequest({hostname:'api.openai.com',port:443,path:'/v1/responses',method:'POST',servername:'api.openai.com',rejectUnauthorized:true,headers:{authorization:'Bearer '+token,'content-type':'application/json','content-length':String(count),accept:'text/event-stream, application/json'}},response=>{
          if(response.statusCode<200 || response.statusCode>=300) {response.resume();res.writeHead(502,{'connection':'close'}).end();return;}
          const type=String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if(!['application/json','text/event-stream'].includes(type)) {response.resume();res.writeHead(502,{'connection':'close'}).end();return;}
          let n=0;
          res.writeHead(response.statusCode,{'content-type':type,'connection':'close'});
          response.on('data',data=>{n+=data.length;if(n>16777216){response.destroy();res.destroy();}else if(!res.write(data)) response.pause();});
          res.on('drain',()=>response.resume());
          response.on('end',()=>res.end());
          response.on('error',()=>res.destroy());
        });
        upstream.setTimeout(120000,()=>upstream.destroy());
        controller.signal.addEventListener('abort',()=>upstream.destroy(),{once:true});
        const deadline=setTimeout(()=>upstream.destroy(),120000);
        upstream.once('close',()=>clearTimeout(deadline));
        upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,{'connection':'close'}).end();else res.destroy();});
        res.once('close',()=>upstream.destroy());
        for(const c of chunks) upstream.write(c);
        chunks=[]; token=null; upstream.end();
      } catch { chunks=[];token=null;if(!res.headersSent)res.writeHead(502,{'connection':'close'}).end();else res.destroy(); }
    });
  });
  for(const name of ['connect','upgrade']) server.on(name,(_req,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  for(const name of ['checkContinue','checkExpectation']) server.on(name,(_req,res)=>res.writeHead(417,{'connection':'close'}).end());
  server.on('clientError',(_err,socket)=>socket.destroy());
  server.headersTimeout=10000; server.requestTimeout=15000; server.keepAliveTimeout=1000;
  return server;
}
module.exports={authorizeReviewRequest,createReviewRelay};
