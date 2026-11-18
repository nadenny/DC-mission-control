/* DC Mission Control — shared cloud sync for tools that keep their data in
   localStorage (concern log, semester checklist, sheet builder).

   Uses the same Firebase project and sign-in as Mission Control: sign in once
   there and every tool on this site is signed in too.

   Safety rules this file follows:
   • The FIRST time a device syncs a tool, local and cloud are MERGED item by
     item. Nothing on either side is dropped.
   • After that, edits push to the cloud and other devices' edits come down.
     If this device has edits that never reached the cloud (offline, closed
     the tab) AND the cloud changed meanwhile, the two are merged again
     instead of one replacing the other.
   • An empty or missing cloud copy never wipes local data.
   • Each collection is stored in the cloud as an exact JSON string, so the
     data comes back byte-for-byte the same.

   Usage (in a tool page, after its own script):
     DCSync.attach({
       node:'concern',
       collections:{ cases:{key:'dc_concern_log_v2', kind:'list', ...} },
       onRemote:names=>{ load(); render(); }
     });
*/
(function(){
'use strict';
const CFG_KEY  = 'dc_fb_config_v1';
const META_KEY = 'dc_sync_meta_v1';
const FB_VER   = '10.12.2';

const realSet = Storage.prototype.setItem;
let applying  = false;

/* ── small helpers ── */
function parse(raw){ if(raw==null)return undefined; try{return JSON.parse(raw);}catch{return undefined;} }
function decode(c,raw){ return c.raw?(raw==null?undefined:raw):parse(raw); }
function encode(c,val){ return c.raw?String(val):JSON.stringify(val); }
function same(a,b){ return JSON.stringify(a)===JSON.stringify(b); }
function readMeta(){ return parse(localStorage.getItem(META_KEY))||{}; }
function writeMeta(m){ try{ realSet.call(localStorage,META_KEY,JSON.stringify(m)); }catch{} }
function loadScript(src){
  return new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src=src; s.onload=res; s.onerror=()=>rej(new Error('Could not load '+src));
    document.head.appendChild(s);
  });
}

/* ── merging ── */
function stamp(x){
  if(!x||typeof x!=='object')return '';
  return String(x.updatedAt||x.savedAt||x.lastUsed||x.date||x.addedAt||'');
}
function mergeList(c,local,remote){
  if(!Array.isArray(local))  return remote;
  if(!Array.isArray(remote)) return local;
  const keyOf=c.keyOf||(x=>x&&x.id);
  const out=remote.slice();
  const idx=new Map();
  out.forEach((x,i)=>{const k=keyOf(x); if(k!=null&&!idx.has(k))idx.set(k,i);});
  for(const x of local){
    const k=keyOf(x);
    if(k==null){ if(!out.some(y=>same(x,y)))out.push(x); continue; }
    if(!idx.has(k)){ out.push(x); idx.set(k,out.length-1); continue; }
    const i=idx.get(k), y=out[i];
    if(same(x,y))continue;
    if(c.sameItem&&!c.sameItem(x,y)){        // same id, genuinely different item
      const nx=c.rekey?c.rekey(x,out):x;
      out.push(nx); idx.set(keyOf(nx),out.length-1); continue;
    }
    if(stamp(x)>stamp(y))out[i]=x;           // same item, edited — keep the newer
  }
  return out;
}
function mergeMap(c,local,remote){
  if(!local||typeof local!=='object')  return remote;
  if(!remote||typeof remote!=='object')return local;
  if(c.mergeValue){
    const out={...remote};
    Object.keys(local).forEach(k=>{ out[k]=k in remote?c.mergeValue(local[k],remote[k]):local[k]; });
    return out;
  }
  return {...local,...remote};
}
function merge(c,local,remote){
  if(local===undefined) return remote;
  if(remote===undefined)return local;
  if(c.kind==='list')return mergeList(c,local,remote);
  if(c.kind==='map') return mergeMap(c,local,remote);
  return remote;                              // 'value': cloud wins, local kept if cloud has none
}

/* ── status pill ── */
let pill=null;
function chip(state,label,detail){
  if(!pill){
    pill=document.createElement('button');
    pill.type='button';
    pill.setAttribute('aria-label','Cloud sync status');
    pill.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;align-items:center;gap:6px;'+
      'font:500 10px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;'+
      'padding:6px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.35);'+
      'background:rgba(20,24,32,.88);color:#cbd5e1;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25)';
    pill.innerHTML='<span style="width:7px;height:7px;border-radius:50%"></span><span></span>';
    pill.onclick=()=>alert(pill.dataset.detail||'');
    (document.body||document.documentElement).appendChild(pill);
  }
  const col={on:'#4ADE80',warn:'#FBBF24',off:'#94A3B8',err:'#F87171'}[state]||'#94A3B8';
  pill.firstChild.style.background=col;
  pill.lastChild.textContent=label;
  pill.dataset.detail=detail||label;
}

/* ── main ── */
function attach(opts){
  const node=opts.node, cols=opts.collections;
  const byKey={};
  Object.entries(cols).forEach(([name,c])=>{ byKey[c.key]=name; });

  let db=null, uid=null, ref=null, live=false;
  const timers={}, lastPushed={};

  function metaFor(){
    const m=readMeta();
    if(!m[node])m[node]={uid:null,cols:{}};
    return m;
  }
  function setColMeta(name,patch){
    const m=metaFor();
    m[node].cols[name]={...(m[node].cols[name]||{}),...patch};
    writeMeta(m);
  }
  function colMeta(name){ return (metaFor()[node].cols[name])||{}; }

  function writeLocal(c,val){
    applying=true;
    try{ localStorage.setItem(c.key,encode(c,val)); }
    finally{ applying=false; }
  }

  function push(name){
    const c=cols[name];
    if(!ref||!live)return;
    const raw=localStorage.getItem(c.key);
    if(raw==null)return;
    const at=Date.now();
    lastPushed[name]=at;
    ref.child(name).set({json:raw,at}).then(()=>{
      setColMeta(name,{syncedAt:at,pending:false});
      chip('on','Synced','Synced with your Mission Control account.');
    }).catch(e=>{
      chip('err','Sync error','Could not save to the cloud: '+(e&&e.message||e)+'\n\nYour data is still saved on this device.');
    });
  }

  /* The page wrote one of our keys → remember it's unsynced, push soon. */
  function noteLocalChange(name){
    setColMeta(name,{pending:true});
    if(!live)return;
    clearTimeout(timers[name]);
    timers[name]=setTimeout(()=>push(name),800);
  }

  Storage.prototype.setItem=function(k,v){
    realSet.call(this,k,v);
    if(this===localStorage&&!applying&&byKey[k])noteLocalChange(byKey[k]);
  };

  /* First contact after sign-in (or page load) */
  async function connect(user){
    uid=user.uid;
    ref=db.ref('users/'+uid+'/'+node);
    chip('warn','Connecting','Connecting to the cloud…');
    let remoteAll;
    try{ remoteAll=(await ref.once('value')).val()||{}; }
    catch(e){ chip('err','Sync error','Could not read the cloud: '+(e&&e.message||e)+'\n\nYour data is still saved on this device.'); return; }

    const m=metaFor();
    const joined=m[node].uid===uid;
    const changed=[];
    live=true;

    for(const [name,c] of Object.entries(cols)){
      const r=remoteAll[name];
      const remoteVal=r&&typeof r.json==='string'?decode(c,r.json):undefined;
      const localVal=decode(c,localStorage.getItem(c.key));
      const meta=joined?colMeta(name):{};
      let result, needPush=false;

      if(!joined){
        result=merge(c,localVal,remoteVal);                    // first time: union
        needPush=result!==undefined&&!same(result,remoteVal);
      }else if(meta.pending){
        const cloudMoved=r&&r.at!==meta.syncedAt;
        result=cloudMoved?merge(c,localVal,remoteVal):localVal; // both changed → union
        needPush=result!==undefined;
      }else{
        result=remoteVal!==undefined?remoteVal:localVal;        // nothing local → take cloud
        needPush=remoteVal===undefined&&localVal!==undefined;
        if(r)setColMeta(name,{syncedAt:r.at});
      }
      if(result!==undefined&&!same(result,localVal)){ writeLocal(c,result); changed.push(name); }
      if(needPush)push(name);
    }
    const m2=metaFor(); m2[node].uid=uid; writeMeta(m2);
    if(changed.length&&opts.onRemote){ try{opts.onRemote(changed);}catch(e){console.warn(e);} }
    chip('on','Synced','Synced with your Mission Control account.');

    /* Live updates from other devices */
    Object.entries(cols).forEach(([name,c])=>{
      ref.child(name).on('value',snap=>{
        const r=snap.val();
        if(!r||typeof r.json!=='string')return;               // never wipe local from an empty cloud
        if(r.at===lastPushed[name]||r.at===colMeta(name).syncedAt)return;   // our own echo / already have it
        const remoteVal=decode(c,r.json);
        if(remoteVal===undefined)return;
        const localVal=decode(c,localStorage.getItem(c.key));
        if(colMeta(name).pending){                             // edits in flight on both sides
          const merged=merge(c,localVal,remoteVal);
          if(!same(merged,localVal)){ writeLocal(c,merged); opts.onRemote&&opts.onRemote([name]); }
          clearTimeout(timers[name]); push(name);
          return;
        }
        setColMeta(name,{syncedAt:r.at});
        if(!same(remoteVal,localVal)){
          writeLocal(c,remoteVal);
          try{opts.onRemote&&opts.onRemote([name]);}catch(e){console.warn(e);}
        }
      },e=>chip('err','Sync error','Cloud read failed: '+(e&&e.message||e)));
    });
  }

  function disconnect(){
    live=false;
    if(ref){ Object.keys(cols).forEach(n=>ref.child(n).off()); ref=null; }
  }

  async function start(){
    const raw=localStorage.getItem(CFG_KEY);
    if(!raw){ chip('off','Local only','Saved on this device only. Set up Cloud sync in Mission Control to sync this tool.'); return; }
    try{
      if(!window.firebase||!firebase.database){
        const base='https://www.gstatic.com/firebasejs/'+FB_VER+'/';
        if(!window.firebase)await loadScript(base+'firebase-app-compat.js');
        await loadScript(base+'firebase-auth-compat.js');
        await loadScript(base+'firebase-database-compat.js');
      }
      if(!firebase.apps.length)firebase.initializeApp(parse(raw));
      db=firebase.database();
      firebase.auth().onAuthStateChanged(u=>{
        if(u)connect(u);
        else{ disconnect(); chip('off','Not signed in','Saved on this device only. Sign in to Cloud sync in Mission Control to sync this tool.'); }
      });
    }catch(e){
      chip('err','Sync off','Could not start sync: '+(e&&e.message||e)+'\n\nYour data is still saved on this device.');
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start); else start();

  /* exposed for testing */
  return {merge:(name,l,r)=>merge(cols[name],l,r)};
}

/* Helpers for pages with their own older sync code (home page, meeting tool).
   They keep their cloud format; these just track "has unsent edits" and
   "has this device synced with this account before", and do the merging. */
function legacy(node){
  const get=()=>readMeta()[node]||{};
  const put=p=>{const m=readMeta(); m[node]={...(m[node]||{}),...p}; writeMeta(m);};
  return {
    needsMerge:uid=>{const s=get(); return s.uid!==uid||!!s.pending;},
    markPending:()=>put({pending:true}),
    markSynced:uid=>put({uid,pending:false}),
  };
}
/* Free-text (scratch pad): never drop either side's words. */
function mergeText(local,remote){
  local=local||''; remote=remote||'';
  if(local===remote||remote.includes(local))return remote;
  if(local.includes(remote))return local;
  return remote+'\n\n— from another device —\n'+local;
}

window.DCSync={attach,merge,legacy,mergeText,_merge:merge};
})();
