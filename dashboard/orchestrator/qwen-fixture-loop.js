'use strict';

// Simulation only: no provider registration, repository access, patch apply,
// or automatic dispatch. All callbacks are controlled by the fixture harness.
const {digest}=require('./qwen-supervision');

async function runFixtureLoop({generate, verify, review, usage, budget, deadlineMs, signal, onHistory, onAttempt}) {
  if ([generate,verify,review,usage].some(x=>typeof x!=='function') || !Number.isFinite(budget) || budget<=0 || !Number.isFinite(deadlineMs)) throw Error('Invalid fixture configuration');
  if(onHistory!==undefined && typeof onHistory!=='function') throw Error('Invalid fixture history sink');
  if(onAttempt!==undefined && typeof onAttempt!=='function') throw Error('Invalid fixture attempt sink');
  const history=[]; const seen=new Set(); let feedback=[]; let previousUsage=0; let assertionTotal=null;let current=null;
  const controller=new AbortController();
  const activeSignal=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  const timer=setTimeout(()=>controller.abort(),Math.max(0,Math.min(2147483647,deadlineMs-Date.now())));
  async function invoke(fn,arg) {
    if(activeSignal.aborted)throw Error('fixture-aborted');
    let handler;
    try {
      return await Promise.race([Promise.resolve().then(()=>{if(activeSignal.aborted)throw Error('fixture-aborted');return fn(arg);}),new Promise((_,reject)=>{handler=()=>reject(Error('fixture-aborted'));activeSignal.addEventListener('abort',handler,{once:true});})]);
    } finally { if(handler)activeSignal.removeEventListener('abort',handler); }
  }
  const abortReason=()=>signal?.aborted?'cancelled':(controller.signal.aborted || Date.now()>=deadlineMs?'deadline':null);
  async function guard() {
    if(abortReason())return abortReason();
    let value;try{value=await invoke(usage);}catch{return abortReason() || 'usage-unavailable';}
    if(abortReason())return abortReason();
    if(!Number.isFinite(value) || value<previousUsage) return 'usage-unavailable';
    previousUsage=value;
    return value>=budget ? 'budget' : null;
  }
  const finish=async(status,reason)=>{
    if(onAttempt && current && !current.recorded && reason!=='attempt-persistence-error') {
      const event={attempt:current.attempt,diff:current.diff,technical:current.technical || {passed:0,total:0,errors:[reason],assertions:[]},review:current.review || {decision:'not-run',errors:[]},tokens:current.usageObserved?previousUsage-current.startUsage:null,failure:reason};
      let sinkTimer;
      try { await Promise.race([Promise.resolve().then(()=>onAttempt(event)),new Promise((_,reject)=>{sinkTimer=setTimeout(()=>reject(Error('sink timeout')),2000);})]); }
      catch { reason='attempt-persistence-error'; status='stopped'; }
      finally {clearTimeout(sinkTimer);}
    }
    return {scope:'simulation-only',status,reason,history:structuredClone(history),usage:previousUsage};
  };
  try {
  for(let attempt=1;attempt<=20;attempt++) {
    let stop=await guard(); if(stop)return finish('stopped',stop);
    const startUsage=previousUsage;
    if(attempt===16) {
      const prior=Math.max(...history.slice(0,10).map(x=>x.passed));
      const recent=Math.max(...history.slice(10,15).map(x=>x.passed));
      if(!(recent>prior))return finish('stopped','no-measurable-progress');
    }
    current={attempt,startUsage,diff:null,technical:null,review:null,recorded:false,usageObserved:false};
    let proposal;
    try { proposal=await invoke(generate,{attempt,feedback:[...feedback],history:structuredClone(history),signal:activeSignal}); }
    catch { return finish('stopped',abortReason() || 'generator-error'); }
    if(proposal && typeof proposal.diff==='string')current.diff=proposal.diff;
    stop=await guard(); if(!['usage-unavailable','deadline','cancelled'].includes(stop))current.usageObserved=true;
    if(stop)return finish('stopped',stop);
    if(!proposal || typeof proposal.diff!=='string' || !proposal.diff || Buffer.byteLength(proposal.diff)>2*1024*1024) return finish('stopped','invalid-proposal');
    const diffHash=digest(proposal.diff);
    if(seen.has(diffHash))return finish('stopped','repeated-proposal');
    seen.add(diffHash);
    let technical;
    try { technical=await invoke(verify,{diff:proposal.diff,attempt,signal:activeSignal}); }
    catch { return finish('stopped',abortReason() || 'verification-error'); }
    current.technical=technical;
    stop=await guard(); if(stop)return finish('stopped',stop);
    if(!technical || technical.securityIncident===true) return finish('stopped','security-incident');
    if(!Number.isInteger(technical.passed) || !Number.isInteger(technical.total) || technical.total<1 || technical.passed<0 || technical.passed>technical.total || !Array.isArray(technical.errors) || technical.errors.some(x=>typeof x!=='string' || x.length>1000)) return finish('stopped','invalid-technical-evidence');
    if(technical.unsupported!==undefined && typeof technical.unsupported!=='boolean')return finish('stopped','invalid-technical-evidence');
    if(assertionTotal===null)assertionTotal=technical.total;
    else if(assertionTotal!==technical.total)return finish('stopped','assertion-set-changed');
    if(technical.passed===technical.total && (technical.errors.length || technical.unsupported===true)) return finish('stopped','invalid-technical-evidence');
    let decision;
    try { decision=await invoke(review,{diff:proposal.diff,diffHash,attempt,technical:structuredClone(technical),signal:activeSignal}); }
    catch { return finish('stopped',abortReason() || 'reviewer-unavailable'); }
    current.review=decision;
    stop=await guard(); if(stop)return finish('stopped',stop);
    if(decision?.securityIncident===true)return finish('stopped','security-incident');
    if(!decision || !['pass','fail'].includes(decision.decision) || !Array.isArray(decision.errors) || decision.errors.some(x=>typeof x!=='string' || !x.trim() || x.length>1000) || (decision.decision==='fail' && !decision.errors.length) || (decision.decision==='pass' && decision.errors.length)) return finish('stopped','invalid-review');
    const passed=technical.passed===technical.total;
    feedback=[...technical.errors,...decision.errors].slice(0,20);
    history.push({attempt,diffHash,passed:technical.passed,total:technical.total,review:decision.decision,unsupported:technical.unsupported===true,feedback:[...feedback]});
    if(onAttempt) {
      current.recorded=true;
      try {await invoke(onAttempt,{attempt,diff:proposal.diff,technical:structuredClone(technical),review:structuredClone(decision),tokens:previousUsage-startUsage});}
      catch{return finish('stopped',abortReason() || 'attempt-persistence-error');}
    }
    if(onHistory) {try{await invoke(onHistory,structuredClone(history));}catch{return finish('stopped',abortReason() || 'history-error');}}
    stop=await guard(); if(stop)return finish('stopped',stop);
    if(passed && decision.decision==='pass')return finish('fixture-validated','technical-and-simulated-review');
    if(!feedback.length)return finish('stopped','missing-feedback');
    if(technical.unsupported===true && history.filter(x=>x.unsupported).length>=2)return finish('stopped','unsupported-syntax-repeated');
    if(history.slice(0,-1).some(x=>JSON.stringify(x.feedback)===JSON.stringify(feedback) && x.passed===technical.passed && x.total===technical.total)) return finish('stopped','persistent-blocker');
  }
  return finish('stopped','attempt-limit');
  } finally {clearTimeout(timer);}
}
module.exports={runFixtureLoop};
