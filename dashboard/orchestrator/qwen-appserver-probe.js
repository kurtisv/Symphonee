'use strict';
// Runs only inside a network-disabled disposable container. The credential is
// an inert fixture string and the upstream is a loopback-only fake server.
const http=require('node:http');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
require('node:fs').mkdirSync('/tmp/codex-probe',{recursive:true});
let child, timer, finished=false, buffer='', stderr='', captured=[];
const server=http.createServer((req,res)=>{
  const chunks=[]; req.on('data',c=>chunks.push(c));
  req.on('end',()=>{
    const body=Buffer.concat(chunks); let keys=[],summary=null;
    try {
      const value=JSON.parse(body.toString('utf8'));keys=Object.keys(value).sort();
      summary={model:value.model,stream:value.stream,maxOutputTokens:value.max_output_tokens ?? null,toolCount:Array.isArray(value.tools)?value.tools.length:null,toolNames:Array.isArray(value.tools)?value.tools.map(x=>x.name || x.type):null,inputCount:Array.isArray(value.input)?value.input.length:null,inputRoles:Array.isArray(value.input)?value.input.map(x=>({type:x.type || null,role:x.role || null,contentKinds:Array.isArray(x.content)?x.content.map(y=>y.type || null):typeof x.content})):null};
    } catch {}
    captured.push({method:req.method,path:req.url,headers:Object.keys(req.headers).sort(),bodyKeys:keys,summary,bodyBytes:body.length,bodyHash:crypto.createHash('sha256').update(body).digest('hex')});
    res.writeHead(400,{'content-type':'application/json'}).end('{"error":{"message":"fixture only"}}');
    if(req.method==='POST') finish(null);
  });
});
function finish(error) {
  if(finished)return; finished=true; clearTimeout(timer);
  if(child)child.kill(); server.close();
  process.stdout.write(JSON.stringify({ok:!error,error:error||null,requests:captured})+'\n');
  if(error)process.exitCode=1;
}
server.listen(0,'127.0.0.1',()=>{
  const port=server.address().port;
  const args=['app-server','--listen','stdio://','-c','model_provider="fixture"','-c','model_providers.fixture.name="Fixture"','-c',`model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`,'-c','model_providers.fixture.env_key="ACCESS_TOKEN"','-c','model_providers.fixture.wire_api="responses"','-c','model_providers.fixture.requires_openai_auth=false','-c','model_providers.fixture.supports_websockets=false','-c','features.shell_tool=false','-c','features.unified_exec=false','-c','features.multi_agent=false','-c','features.view_image=false','-c','features.goals=false','-c','web_search="disabled"'];
  child=spawn('/usr/local/bin/codex',args,{cwd:'/tmp',env:{PATH:process.env.PATH,HOME:'/tmp',CODEX_HOME:'/tmp/codex-probe',ACCESS_TOKEN:'fixture-only'},stdio:['pipe','pipe','pipe']});
  child.on('error',()=>finish('spawn failed'));
  child.stdout.on('data',chunk=>{
    buffer+=chunk.toString(); let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let m;try{m=JSON.parse(line);}catch{continue;}
      if(m.id===1 && m.result){child.stdin.write(JSON.stringify({method:'initialized'})+'\n');child.stdin.write(JSON.stringify({id:2,method:'thread/start',params:{model:'gpt-5.1-codex-mini',cwd:'/tmp',approvalPolicy:'never',sandbox:'read-only'}})+'\n');}
      if(m.id===2 && m.result?.thread?.id) child.stdin.write(JSON.stringify({id:3,method:'turn/start',params:{threadId:m.result.thread.id,input:[{type:'text',text:'Fixture only: return hello.'}]}})+'\n');
      if(m.error && (m.id===1 || m.id===2 || m.id===3))finish('protocol refused: '+String(m.error.message||'unknown').slice(0,150));
    }
  });
  child.stderr.on('data',chunk=>{if(stderr.length<1500)stderr+=chunk.toString().replaceAll('fixture-only','[fixture]');});
  child.on('close',()=>{if(!finished)finish('app-server exited: '+stderr.slice(0,1000));});
  child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'symphonee-fixture',title:'Fixture',version:'1.0'},capabilities:{}}})+'\n');
  timer=setTimeout(()=>finish('probe timed out'),20000);
});
