'use strict';

// Experimental quarantine journal. It records intent before Docker operations;
// it never authorizes a review or treats an empty listing as a server barrier.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function makeResourceJournal(directory) {
  fs.mkdirSync(directory, { recursive:true });
  const root=fs.realpathSync(directory);
  const file=id=>{
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid resource id');
    return path.join(root,id+'.json');
  };
  function write(record, initial=false) {
    const dest=file(record.id);
    const temp=path.join(root,record.id+'.'+crypto.randomBytes(8).toString('hex')+'.tmp');
    const fd=fs.openSync(initial ? dest : temp,'wx',0o600);
    try { fs.writeFileSync(fd,JSON.stringify(record)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!initial) fs.renameSync(temp,dest);
    return record;
  }
  function load(id) {
    const r=JSON.parse(fs.readFileSync(file(id),'utf8'));
    const names={worker:'sym-review-'+id+'-worker',relay:'sym-review-'+id+'-relay',network:'sym-review-'+id+'-network'};
    if (!r || Object.keys(r).sort().join(',')!=='createdAt,id,names,state,version' || r.id!==id || r.version!==1 || !['intent','uncertain'].includes(r.state) ||
        !r.names || Object.keys(r.names).sort().join(',')!=='network,relay,worker' || Object.keys(names).some(k=>r.names[k]!==names[k]) ||
        typeof r.createdAt!=='string' || !Number.isFinite(Date.parse(r.createdAt))) throw Error('Invalid journal record');
    return r;
  }
  return {
    begin() {
      const id=crypto.randomBytes(16).toString('hex');
      return write({version:1,id,state:'intent',names:{worker:'sym-review-'+id+'-worker',relay:'sym-review-'+id+'-relay',network:'sym-review-'+id+'-network'},createdAt:new Date().toISOString()},true);
    },
    load,
    markUncertain(id) {
      file(id);
      const lock=path.join(root,id+'.lock'); const fd=fs.openSync(lock,'wx',0o600);
      try { const r=load(id); return write({...r,state:'uncertain'}); }
      finally { fs.closeSync(fd); fs.unlinkSync(lock); }
    },
    async reconcile(id, lookup, remove) {
      const r=load(id);
      if(typeof lookup!=='function' || typeof remove!=='function') throw Error('Invalid reconciliation');
      const lock=path.join(root,id+'.lock');
      const lockFd=fs.openSync(lock,'wx',0o600);
      try {
      const removed=[];
      for (const kind of ['worker','relay','network']) {
        const name=r.names[kind];
        const resource=await lookup(kind,name);
        if (!resource) continue;
        if (resource.name!==name || resource.labels?.['com.symphonee.review-id']!==id || typeof resource.id!=='string' || !/^[a-f0-9]{64}$/.test(resource.id)) throw Error('Resource identity mismatch');
        await remove(kind,resource.id);
        if(await lookup(kind,name)) throw Error('Resource still present');
        removed.push(kind);
      }
      // Absence is only an observation, not proof that an in-flight create
      // cannot finish later. In particular uncertain records remain pending.
      return { id, removed, pending:true, state:r.state };
      } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
    },
    // No public settle operation exists until a reliable daemon barrier is
    // implemented. A caller-provided boolean is not proof of cleanup.
    pending() {
      const entries=fs.readdirSync(root);
      if(entries.some(n=>!/^[a-f0-9]{32}\.json$/.test(n))) throw Error('Uncertain journal metadata');
      return entries.map(n=>load(n.slice(0,32)));
    },
  };
}
module.exports={makeResourceJournal};
