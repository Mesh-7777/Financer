/* Paisa Ledger — shared household expense tracker
   Frontend: static, hostable on GitHub Pages.
   Backend:  Firebase Auth (Google) + Cloud Firestore.
   Access control lives in firestore.rules; the UI only mirrors it. */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, collectionGroup, doc, getDoc, getDocs, setDoc, updateDoc,
  deleteDoc, deleteField, onSnapshot, query, where, orderBy, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* ---------------- constants ---------------- */
const CAT_COLORS=["#D2603C","#4E9A5F","#3E86B5","#7B62C0","#C08A2E","#CE5F8C","#3FA294","#6E8F3C","#2F9BB5","#8A7A44","#2E8B57","#A05A3C","#7E7EC8","#7A8880"];
const DEF_EXP=["Food & Dining","Groceries","Transport","Rent","Bills & Recharge","Shopping","Health","Entertainment","Travel","Education","Investments","EMI & Loans","Furniture & Home","Other"];
const DEF_INC=["Salary","Freelance","Interest","Refund","Cashback","Other"];
const METHODS=["UPI","Card","Cash","Netbanking","Wallet"];
const KINDS={emi:"EMI / loan",sub:"Subscription",bill:"Bill",rent:"Rent"};
const DISCRETIONARY=["Food & Dining","Shopping","Entertainment","Travel","Furniture & Home"];
const PERSON_COLORS=["#0C6B5A","#B4471F","#3E86B5","#7B62C0","#C08A2E","#CE5F8C"];

const nf=new Intl.NumberFormat("en-IN",{maximumFractionDigits:0});
const nf2=new Intl.NumberFormat("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2});
const money=n=>"₹"+nf.format(Math.round(n||0));
const money2=n=>"₹"+nf2.format(n||0);
const now=()=>Date.now();
const pad=n=>String(n).padStart(2,"0");
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ymd=d=>{const x=new Date(d);return x.getFullYear()+"-"+pad(x.getMonth()+1)+"-"+pad(x.getDate())};
const monthOf=s=>String(s).slice(0,7);
const MON=["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const rid=()=>Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);

/* ---------------- app state ---------------- */
// A deleted ledger is kept for this many days before it is actually purged.
const GRACE_DAYS=30;

const A={
  me:null,                 // firebase user
  ledgers:[],              // [{id,name,ownerUid,role}]
  deleted:[],              // soft-deleted ledgers this user owns, awaiting purge
  lid:null,                // current ledger id
  ledger:null,             // current ledger doc data
  members:[],              // [{uid,name,email,role,photo}]
  invites:[],              // [{email,role}]
  entries:[], goals:[], recur:[],
  unsub:[],                // active listeners for current ledger
  allowed:false, seed:false, openInvites:true, allowList:[],
  loading:true, errored:null,
  postedRecur:new Set()     // guards double-posting within a session
};
let ui={tab:"add",month:monthOf(ymd(new Date())),type:"expense",cat:null,method:"UPI",q:"",filterCat:"",filterWho:"",editing:null,busy:false,
  draft:{amt:"",note:"",date:""},picker:null,ovRange:"month"};

const settings=()=>Object.assign(
  {budget:0,catBudgets:{},cats:DEF_EXP.slice(),incomeCats:DEF_INC.slice()},
  (A.ledger&&A.ledger.settings)||{});
const myRole=()=>{ const m=A.members.find(x=>x.uid===(A.me&&A.me.uid)); return m?m.role:"none"; };
const isOwner=()=>!!(A.ledger&&A.me&&A.ledger.ownerUid===A.me.uid);
const canWrite=()=>isOwner()||myRole()==="editor";
const canModify=d=>isOwner()||(canWrite()&&d&&d.uid===A.me.uid);
const memberName=uid=>{ const m=A.members.find(x=>x.uid===uid); return m?(m.name||m.email||"Someone"):"Someone"; };
const personColor=uid=>{ const i=Math.max(0,A.members.findIndex(x=>x.uid===uid)); return PERSON_COLORS[i%PERSON_COLORS.length]; };

/* ---------------- small helpers ---------------- */
function toast(msg){
  document.querySelectorAll(".toast").forEach(n=>n.remove());
  const el=document.createElement("div"); el.className="toast"; el.textContent=msg;
  document.body.appendChild(el); setTimeout(()=>el.remove(),3200);
}
function catColor(name){
  const s=settings(), all=s.cats.concat(s.incomeCats);
  let i=all.indexOf(name);
  if(i<0){ let h=0; for(const c of String(name)) h=(h*31+c.charCodeAt(0))>>>0; i=h; }
  return CAT_COLORS[i%CAT_COLORS.length];
}
function shiftMonth(m,d){ const[y,mo]=m.split("-").map(Number),x=new Date(y,mo-1+d,1); return x.getFullYear()+"-"+pad(x.getMonth()+1); }
function monthLabel(m){ const[y,mo]=m.split("-").map(Number); return MON[mo-1]+" "+y; }
function monthShort(m){ const[y,mo]=m.split("-").map(Number); return MONS[mo-1]+" "+String(y).slice(2); }
function daysIn(m){ const[y,mo]=m.split("-").map(Number); return new Date(y,mo,0).getDate(); }
function monthsBetween(a,b){ const[y1,m1]=a.split("-").map(Number),[y2,m2]=b.split("-").map(Number); return (y2-y1)*12+(m2-m1); }
function fmtDay(d,opts){ return new Date(d+"T00:00:00").toLocaleDateString("en-IN",opts); }
function parseAmt(s){ const n=parseFloat(String(s).replace(/[^0-9.]/g,"")); return isFinite(n)?Math.round(n*100)/100:NaN; }
function val(id){ const n=document.getElementById(id); return n?n.value:""; }
function denied(e){ return e&&(e.code==="permission-denied"||e.code==="firestore/permission-denied"); }
async function guard(fn,okMsg){
  if(ui.busy) return;
  ui.busy=true;
  try{ await fn(); if(okMsg) toast(okMsg); }
  catch(e){
    console.error(e);
    toast(denied(e)?"You don't have permission to do that in this ledger":"Couldn't save — "+(e.message||"unknown error"));
  }
  finally{ ui.busy=false; }
}

/* ---------------- auth ---------------- */
const provider=new GoogleAuthProvider();
provider.setCustomParameters({prompt:"select_account"});

function bootSignedOut(err){
  const b=document.getElementById("bootbody");
  b.innerHTML=`
    <button class="gbtn" id="signin">
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2.5 24 .5 14.6.5 6.5 5.9 2.6 13.7l7.8 6.1C12.3 13.6 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.6 24.6c0-1.7-.2-3.3-.5-4.8H24v9.1h12.7c-.5 3-2.2 5.5-4.7 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17.3z"/><path fill="#FBBC05" d="M10.4 28.2a14.5 14.5 0 0 1 0-8.4l-7.8-6.1a24 24 0 0 0 0 20.6l7.8-6.1z"/><path fill="#34A853" d="M24 47.5c6.2 0 11.5-2 15.3-5.6l-7.5-5.8c-2.1 1.4-4.8 2.2-7.8 2.2-6.4 0-11.7-4.1-13.6-9.9l-7.8 6.1C6.5 42.1 14.6 47.5 24 47.5z"/></svg>
      Continue with Google
    </button>
    ${err?`<p class="hint" style="margin-top:14px;color:var(--danger)">${esc(err)}</p>`:""}`;
  document.getElementById("signin").onclick=async()=>{
    try{ await signInWithPopup(auth,provider); }
    catch(e){
      if(e.code==="auth/popup-blocked"||e.code==="auth/cancelled-popup-request"||e.code==="auth/operation-not-supported-in-this-environment"){
        try{ await signInWithRedirect(auth,provider); }catch(e2){ bootSignedOut(e2.message); }
      } else if(e.code!=="auth/popup-closed-by-user"){
        bootSignedOut(e.code==="auth/unauthorized-domain"
          ? "This domain isn't authorised in your Firebase project. Add it under Authentication → Settings → Authorized domains."
          : e.message);
      }
    }
  };
}
getRedirectResult(auth).catch(e=>console.warn("redirect result",e));

onAuthStateChanged(auth,async user=>{
  A.me=user;
  if(!user){
    A.unsub.forEach(u=>u()); A.unsub=[];
    document.getElementById("app").hidden=true;
    document.getElementById("boot").hidden=false;
    bootSignedOut(null);
    return;
  }
  try{
    await setDoc(doc(db,"users",user.uid),{
      uid:user.uid, email:(user.email||"").toLowerCase(),
      name:user.displayName||user.email||"", photo:user.photoURL||"", seen:serverTimestamp()
    },{merge:true});
  }catch(e){ console.warn("profile",e); }

  await loadAccess();
  if(!A.allowed){ bootNeedsInvite(); return; }

  document.getElementById("boot").hidden=true;
  document.getElementById("app").hidden=false;
  paintMe();
  await loadLedgers();
});

/* ---------------- invite-only gate ----------------
   An email has to appear under /allowed before it can start a ledger.
   Creating an invite enrols the invitee, so the invite flow is the only
   door in; the first entry is seeded by hand in the Firebase console. */
async function loadAccess(){
  const email=(A.me.email||"").toLowerCase();
  A.allowed=false; A.seed=false; A.openInvites=true; A.allowList=[];
  try{
    const d=await getDoc(doc(db,"allowed",email));
    A.allowed=d.exists();
    A.seed=A.allowed&&d.data().seed===true;
  }catch(e){ console.warn("access",e); }
  try{
    const c=await getDoc(doc(db,"config","app"));
    A.openInvites=!c.exists()||c.data().openInvites!==false;
  }catch(e){}
  if(A.seed) await loadAllowList();
}
async function loadAllowList(){
  try{
    const s=await getDocs(collection(db,"allowed"));
    A.allowList=s.docs.map(d=>Object.assign({email:d.id},d.data()))
      .sort((a,b)=>(b.seed?1:0)-(a.seed?1:0)||a.email.localeCompare(b.email));
  }catch(e){ console.warn("allowlist",e); }
}
function bootNeedsInvite(){
  document.getElementById("app").hidden=true;
  document.getElementById("boot").hidden=false;
  document.getElementById("bootbody").innerHTML=`
    <div class="note warn" style="text-align:left;display:block">
      <b>You'll need an invite.</b><br>
      This ledger is invite-only. Ask whoever runs it to invite
      <b>${esc(A.me.email||"this address")}</b>, then open their link again.
    </div>
    <button class="btn ghost sm" id="gate-out" style="margin-top:16px">Sign out</button>
    <p class="hint" style="margin-top:12px">Signed in as ${esc(A.me.email||"")} — if that's the wrong Google account, sign out and try the other one.</p>`;
  document.getElementById("gate-out").onclick=()=>signOut(auth);
}

function paintMe(){
  const el=document.getElementById("mebtn");
  if(A.me&&A.me.photoURL) el.innerHTML=`<img src="${esc(A.me.photoURL)}" alt="" referrerpolicy="no-referrer">`;
  else el.textContent=((A.me&&(A.me.displayName||A.me.email))||"?").trim()[0].toUpperCase();
}

/* ---------------- ledgers & membership ---------------- */
async function loadLedgers(){
  A.loading=true; render();
  // Any invite link in the URL is claimed before we list ledgers.
  const join=(location.hash.match(/join=([A-Za-z0-9_-]+)/)||[])[1];
  if(join){ history.replaceState(null,"",location.pathname+location.search); await claimInvite(join); }

  let snap;
  try{
    snap=await getDocs(query(collectionGroup(db,"members"),where("uid","==",A.me.uid)));
  }catch(e){
    console.error(e); A.loading=false; A.errored=e; return render();
  }
  const rows=[];
  snap.forEach(d=>{
    const lid=d.ref.parent.parent && d.ref.parent.parent.id;
    if(lid) rows.push({id:lid,role:d.data().role});
  });
  const full=[];
  for(const r of rows){
    try{
      const ls=await getDoc(doc(db,"ledgers",r.id));
      if(ls.exists()) full.push(Object.assign({id:r.id,role:r.role},ls.data()));
    }catch(e){ /* membership without a readable ledger — skip */ }
  }
  // A soft-deleted ledger is gone as far as everyone is concerned; only its
  // owner still sees it, in Recently deleted, until the grace period lapses.
  A.ledgers=full.filter(l=>!l.deletedAt).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  A.deleted=full.filter(l=>l.deletedAt&&l.ownerUid===A.me.uid)
    .sort((a,b)=>(a.deletedAt<b.deletedAt?1:-1));
  purgeExpired();

  if(!A.ledgers.length){ await createLedger(firstName()+"'s ledger",true); return; }
  const remembered=localStorage.getItem("paisa.lid");
  const pick=A.ledgers.find(l=>l.id===remembered)||A.ledgers[0];
  await openLedger(pick.id);
}
function firstName(){
  const n=(A.me.displayName||A.me.email||"My").trim();
  return n.split(/[\s@.]/)[0].replace(/^./,c=>c.toUpperCase());
}
async function createLedger(name,silent){
  const id=rid();
  await setDoc(doc(db,"ledgers",id),{
    name, ownerUid:A.me.uid, createdAt:serverTimestamp(),
    settings:{budget:0,catBudgets:{},cats:DEF_EXP.slice(),incomeCats:DEF_INC.slice()}
  });
  await setDoc(doc(db,"ledgers",id,"members",A.me.uid),{
    uid:A.me.uid, role:"owner", email:(A.me.email||"").toLowerCase(),
    name:A.me.displayName||"", photo:A.me.photoURL||"", joinedAt:serverTimestamp()
  });
  A.ledgers.push({id,name,ownerUid:A.me.uid,role:"owner"});
  await openLedger(id);
  if(!silent) toast("Ledger created");
}
async function claimInvite(lid){
  const email=(A.me.email||"").toLowerCase();
  if(!email) return;
  try{
    const inv=await getDoc(doc(db,"ledgers",lid,"invites",email));
    if(!inv.exists()){ toast("That invite isn't for this account, or it was withdrawn"); return; }
    const role=inv.data().role;
    await setDoc(doc(db,"ledgers",lid,"members",A.me.uid),{
      uid:A.me.uid, role, email, name:A.me.displayName||"", photo:A.me.photoURL||"", joinedAt:serverTimestamp()
    });
    await deleteDoc(doc(db,"ledgers",lid,"invites",email)).catch(()=>{});
    localStorage.setItem("paisa.lid",lid);
    toast("You've joined as "+(role==="viewer"?"a viewer":"an editor"));
  }catch(e){
    console.error(e);
    toast(denied(e)?"That invite couldn't be claimed with this Google account":"Couldn't join — "+(e.message||""));
  }
}
async function openLedger(lid){
  A.unsub.forEach(u=>u()); A.unsub=[];
  A.lid=lid; A.ledger=null; A.members=[]; A.invites=[]; A.entries=[]; A.goals=[]; A.recur=[];
  A.loading=true; A.errored=null;
  localStorage.setItem("paisa.lid",lid);
  render();

  const onErr=tag=>e=>{ console.error(tag,e); if(denied(e)){ A.errored=e; render(); } };
  const L=doc(db,"ledgers",lid);

  A.unsub.push(onSnapshot(L,s=>{ A.ledger=s.exists()?s.data():null; A.loading=false; render(); },onErr("ledger")));
  A.unsub.push(onSnapshot(collection(L,"members"),s=>{
    A.members=s.docs.map(d=>Object.assign({uid:d.id},d.data()));
    render();
  },onErr("members")));
  A.unsub.push(onSnapshot(query(collection(L,"entries"),orderBy("date","desc"),limit(2000)),s=>{
    A.entries=s.docs.map(d=>Object.assign({id:d.id},d.data()));
    render(); maybePostRecurring();
  },onErr("entries")));
  A.unsub.push(onSnapshot(collection(L,"goals"),s=>{
    A.goals=s.docs.map(d=>Object.assign({id:d.id},d.data())); render();
  },onErr("goals")));
  A.unsub.push(onSnapshot(collection(L,"recur"),s=>{
    A.recur=s.docs.map(d=>Object.assign({id:d.id},d.data())); render(); maybePostRecurring();
  },onErr("recur")));
  A.unsub.push(onSnapshot(collection(L,"invites"),s=>{
    A.invites=s.docs.map(d=>Object.assign({email:d.id},d.data())); render();
  },()=>{}));
}

/* ---------------- recurring engine ---------------- */
function recDates(r,untilMonth){
  const out=[]; if(!r.start) return out;
  let m=r.start, guard=0;
  const capBack=shiftMonth(monthOf(ymd(new Date())),-24);
  while(monthsBetween(m,untilMonth)>=0 && guard++<400){
    if(r.count>0 && out.length>=r.count) break;
    out.push({m,date:m+"-"+pad(Math.min(r.day||1,daysIn(m))),old:monthsBetween(capBack,m)<0});
    m=shiftMonth(m,1);
  }
  return out;
}
function emiProgress(r){
  const today=ymd(new Date()), all=recDates(r,monthOf(today));
  const paid=all.filter(d=>d.date<=today).length, total=r.count>0?r.count:0;
  return {paid,total,left:total?Math.max(0,total-paid):0,outstanding:total?Math.max(0,total-paid)*r.amt:0};
}
function nextDue(r){
  const t=ymd(new Date());
  const d=recDates(r,shiftMonth(monthOf(t),1)).find(x=>x.date>=t);
  return d?d.date:null;
}
const monthlyCommitment=()=>A.recur.reduce((a,r)=>{
  if(r.kind==="emi"){ const p=emiProgress(r); if(p.total&&p.left<=0) return a; }
  return a+(r.amt||0);
},0);

// Posts due instalments as real entries. Deterministic ids keep two devices
// (or two people) from creating duplicates. Only the ledger owner or the
// person who set the item up posts it.
async function maybePostRecurring(){
  if(!canWrite()||!A.lid) return;
  const today=ymd(new Date()), curM=monthOf(today);
  const have=new Set(A.entries.map(e=>e.id));
  const jobs=[];
  A.recur.forEach(r=>{
    if(r.auto===false) return;
    if(!(isOwner()||r.uid===A.me.uid)) return;
    recDates(r,curM).forEach(d=>{
      if(d.old||d.date>today) return;
      const id="r_"+r.id+"_"+d.m;
      if(have.has(id)||A.postedRecur.has(id)) return;
      A.postedRecur.add(id);
      jobs.push(setDoc(doc(db,"ledgers",A.lid,"entries",id),{
        amt:r.amt,type:"expense",cat:r.cat,method:r.method||"Netbanking",note:r.name,
        date:d.date,uid:A.me.uid,by:A.me.displayName||"",rec:r.id,u:now(),createdAt:serverTimestamp()
      }).catch(e=>{ A.postedRecur.delete(id); if(!denied(e)) console.warn("recur post",e); }));
    });
  });
  if(jobs.length){ await Promise.all(jobs); }
}

/* ---------------- derived numbers ---------------- */
const monthTx=m=>A.entries.filter(t=>monthOf(t.date)===m);
function stats(m){
  const tx=monthTx(m);
  const spent=tx.filter(t=>t.type==="expense").reduce((a,b)=>a+b.amt,0);
  const income=tx.filter(t=>t.type==="income").reduce((a,b)=>a+b.amt,0);
  const dim=daysIn(m),today=ymd(new Date()),cur=monthOf(today)===m;
  const elapsed=cur?Number(today.slice(8,10)):dim, left=cur?dim-elapsed:0;
  const avg=spent/Math.max(1,elapsed);
  const saved=A.goals.reduce((a,g)=>a+((g.hist||[]).filter(h=>monthOf(h.d)===m).reduce((x,y)=>x+y.a,0)),0);
  const rate=income>0?(income-spent-saved)/income*100:0;
  return {tx,spent,income,saved,net:income-spent,dim,elapsed,left,avg,projected:avg*dim,cur,rate};
}
function txCat(tx){ const o={}; tx.filter(t=>t.type==="expense").forEach(t=>{o[t.cat]=(o[t.cat]||0)+t.amt}); return o; }
function txWho(tx){ const o={}; tx.filter(t=>t.type==="expense").forEach(t=>{o[t.uid]=(o[t.uid]||0)+t.amt}); return o; }
function catSpend(m){ return txCat(monthTx(m)); }
function whoSpend(m){ return txWho(monthTx(m)); }
// All-time totals across every entry ever logged in the ledger, for the
// Overview tab's "All time" toggle — a lifetime view alongside the
// month-scoped one, since the month bar elsewhere still drives Add/Plan/History.
function allStats(){
  const tx=A.entries;
  const spent=tx.filter(t=>t.type==="expense").reduce((a,b)=>a+b.amt,0);
  const income=tx.filter(t=>t.type==="income").reduce((a,b)=>a+b.amt,0);
  const saved=A.goals.reduce((a,g)=>a+((g.hist||[]).reduce((x,y)=>x+y.a,0)),0);
  const dates=tx.map(t=>t.date).sort();
  const months=new Set(tx.map(t=>monthOf(t.date))).size||1;
  const rate=income>0?(income-spent-saved)/income*100:0;
  return {tx,spent,income,saved,net:income-spent,rate,months,avgPerMonth:spent/months,
    from:dates[0]||ymd(new Date()),to:dates[dates.length-1]||ymd(new Date())};
}
function monthFlow(m){
  const tx=monthTx(m);
  return {month:m,income:tx.filter(t=>t.type==="income").reduce((a,b)=>a+b.amt,0),
    expense:tx.filter(t=>t.type==="expense").reduce((a,b)=>a+b.amt,0)};
}
function trendMonths(n){
  const all=[...new Set(A.entries.map(t=>monthOf(t.date)))].sort();
  return all.length?all.slice(-n):[monthOf(ymd(new Date()))];
}
function goalNeed(g){
  const rem=Math.max(0,(g.target||0)-(g.saved||0));
  if(!g.by) return {rem,months:0,perMonth:0};
  const months=Math.max(0,monthsBetween(monthOf(ymd(new Date())),monthOf(g.by)));
  return {rem,months,perMonth:months>0?rem/months:rem};
}

/* ---------------- insights ---------------- */
function insights(m){
  const out=[], s=stats(m), spent=catSpend(m), cb=settings().catBudgets||{};
  const prevMonths=[shiftMonth(m,-1),shiftMonth(m,-2),shiftMonth(m,-3)];
  const prevs=prevMonths.map(catSpend);
  const nMonths=prevMonths.filter(x=>monthTx(x).length).length;
  const avgOf=c=>nMonths?prevs.reduce((a,p)=>a+(p[c]||0),0)/nMonths:0;

  Object.keys(cb).filter(c=>cb[c]>0).forEach(c=>{
    const v=spent[c]||0, cap=cb[c];
    if(v>cap) out.push({w:v-cap,warn:1,title:esc(c)+" is over its envelope",
      body:`${money(v)} spent against a ${money(cap)} cap${s.left?`, with ${s.left} days still to go`:""}.`,save:v-cap});
    else if(s.cur&&s.elapsed>=7&&v/cap>s.elapsed/s.dim*1.35){
      const proj=v/s.elapsed*s.dim;
      out.push({w:proj-cap,warn:1,title:esc(c)+" is running hot",
        body:`${money(v)} by day ${s.elapsed} — on this pace it lands near ${money(proj)} against a ${money(cap)} cap.`,save:Math.max(0,proj-cap)});
    }
  });
  if(nMonths) Object.entries(spent).forEach(([c,v])=>{
    const a=avgOf(c);
    if(a>0&&v>a*1.25&&v-a>=500) out.push({w:v-a,title:esc(c)+" is above your usual",
      body:`${money(v)} this month against a ${money(a)} average over the last ${nMonths} month${nMonths>1?"s":""}.`,save:v-a});
  });
  const groups={};
  monthTx(m).filter(t=>t.type==="expense"&&!t.rec).forEach(t=>{(groups[t.cat]=groups[t.cat]||[]).push(t.amt)});
  Object.entries(groups).forEach(([c,arr])=>{
    if(arr.length>=8){
      const tot=arr.reduce((a,b)=>a+b,0), avg=tot/arr.length;
      if(avg<=800) out.push({w:tot*0.25,title:`${arr.length} separate ${esc(c)} entries`,
        body:`${money(tot)} across ${arr.length} entries averaging ${money(avg)}. Skipping one in four is the cheapest cut here.`,save:tot*0.25});
    }
  });
  const subs=A.recur.filter(r=>r.kind==="sub"||r.kind==="bill");
  if(subs.length){
    const tot=subs.reduce((a,r)=>a+r.amt,0);
    const small=subs.filter(r=>r.amt<=1000).sort((a,b)=>a.amt-b.amt);
    out.push({w:tot*0.3,title:`${money(tot)} a month in bills and subscriptions`,
      body:small.length>=2
        ? `${subs.length} running. The smallest are ${small.slice(0,3).map(r=>esc(r.name)+" "+money(r.amt)).join(", ")} — these are the ones that get forgotten.`
        : `${subs.length} running. Worth a yearly audit of which ones anyone actually opened last month.`,
      save:small.slice(0,2).reduce((a,r)=>a+r.amt,0)});
  }
  const emis=A.recur.filter(r=>r.kind==="emi"&&(!r.count||emiProgress(r).left>0));
  if(emis.length&&s.income>0){
    const tot=emis.reduce((a,r)=>a+r.amt,0), share=tot/s.income*100;
    if(share>=30) out.push({w:tot,warn:1,title:"EMIs take "+Math.round(share)+"% of this month's income",
      body:`${money(tot)} committed across ${emis.length} loan${emis.length>1?"s":""} before anything else is spent. Above roughly 35–40% leaves very little room to absorb a bad month.`});
  }
  if(s.tx.length>=8){
    let we=0,wd=0,wed=0,wdd=0;
    const[yy,mm2]=m.split("-").map(Number), lastDay=s.cur?s.elapsed:s.dim;
    for(let d=1;d<=lastDay;d++){ const g=new Date(yy,mm2-1,d).getDay(); if(g===0||g===6) wed++; else wdd++; }
    s.tx.filter(t=>t.type==="expense").forEach(t=>{
      const g=new Date(t.date+"T00:00:00").getDay(); if(g===0||g===6) we+=t.amt; else wd+=t.amt;
    });
    const wr=wed?we/wed:0, dr=wdd?wd/wdd:0;
    if(dr>0&&wr>dr*1.6&&we>=2000) out.push({w:wr*0.25*wed,
      title:"Weekends cost about "+(Math.round(wr/dr*10)/10)+"× a weekday",
      body:`${money(wr)} on an average weekend day against ${money(dr)} on a weekday. ${money(we)} of the month sits in ${wed} days.`,
      save:wr*0.25*wed});
  }
  A.goals.forEach(g=>{
    const need=goalNeed(g);
    if(need.perMonth>0&&s.income>0&&need.perMonth>s.saved){
      const gap=need.perMonth-s.saved;
      const top=Object.entries(spent).filter(([c])=>DISCRETIONARY.includes(c)).sort((a,b)=>b[1]-a[1])[0];
      out.push({w:gap,title:`"${esc(g.name)}" needs ${money(need.perMonth)} a month`,
        body:`${money(s.saved)} has gone to goals this month, so the gap is ${money(gap)}.`+
          (top?` For scale, ${esc(top[0])} came to ${money(top[1])}.`:"")});
    }
  });
  const big=s.tx.filter(t=>t.type==="expense").sort((a,b)=>b.amt-a.amt)[0];
  if(big&&s.spent>0&&big.amt/s.spent>0.25) out.push({w:big.amt*0.5,
    title:"One entry is "+Math.round(big.amt/s.spent*100)+"% of the month",
    body:`${esc(big.note||big.cat)} — ${money(big.amt)} on ${esc(fmtDay(big.date,{day:"numeric",month:"short"}))}. Worth checking whether the rest of the month is actually the problem.`});
  return out.sort((a,b)=>b.w-a.w).slice(0,5);
}

/* ---------------- render ---------------- */
function render(){
  if(!A.me) return;
  document.getElementById("ledgername").textContent=(A.ledger&&A.ledger.name)||"Loading…";
  const rc=document.getElementById("rolechip");
  const r=isOwner()?"owner":myRole();
  rc.textContent=r==="none"?"—":r;
  rc.className="rolechip"+(r==="owner"?" owner":r==="viewer"?" viewer":"");
  document.getElementById("monthname").textContent=monthLabel(ui.month);
  document.getElementById("nextm").disabled=!(ui.month<monthOf(ymd(new Date())));
  document.querySelectorAll(".tabs button").forEach(b=>b.setAttribute("aria-selected",String(b.dataset.tab===ui.tab)));
  const v=document.getElementById("view");
  if(A.errored){ v.innerHTML=viewDenied(); return; }
  if(A.loading||!A.ledger){ v.innerHTML=`<div class="panel"><div class="spinner" style="margin:24px auto"></div></div>`; return; }
  v.innerHTML={add:viewAdd,overview:viewOverview,plan:viewPlan,history:viewHistory,people:viewPeople,data:viewData}[ui.tab]();
  wire();
}
function viewDenied(){
  return `<section class="panel"><h2 class="sec">This ledger isn't open to you</h2>
    <p class="hint">Your access may have been changed or removed. Pick another ledger from the switcher at the top, or ask the owner to invite you again.</p></section>`;
}
function readOnlyNote(){
  if(canWrite()) return "";
  return `<div class="note warn">You have view-only access to this ledger. You can read everything here but not add or change entries.</div>`;
}

function viewAdd(){
  if(!canWrite()) return readOnlyNote()+`<section class="panel"><p class="eyebrow">Latest</p>${txList(A.entries.slice(0,8),true)}</section>`;
  const s0=settings(), cats=ui.type==="expense"?s0.cats:s0.incomeCats;
  if(!cats.includes(ui.cat)) ui.cat=cats[0];
  const s=stats(ui.month), spent=catSpend(ui.month), cb=s0.catBudgets||{};
  return `
  <section class="panel">
    <p class="eyebrow">New entry</p>
    <div class="amtwrap"><span class="cur">₹</span>
      <input id="amt" type="text" inputmode="decimal" placeholder="0" autocomplete="off" aria-label="Amount" value="${esc(ui.draft.amt)}"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin:14px 0 16px;flex-wrap:wrap">
      <div class="seg" role="group" aria-label="Entry type">
        <button data-type="expense" aria-pressed="${ui.type==="expense"}">Expense</button>
        <button data-type="income" aria-pressed="${ui.type==="income"}">Income</button></div>
      <span class="hint num">${money(s.spent)} spent in ${monthShort(ui.month)}</span>
    </div>
    <div class="field" style="margin-bottom:16px">
      <span class="lbl">Category${ui.type==="expense"?" · remaining in envelope":""}</span>
      <div class="chips">${cats.map(c=>{
        const b=ui.type==="expense"?(cb[c]||0):0, rem=b-(spent[c]||0);
        return `<button class="chip" data-cat="${esc(c)}" aria-pressed="${c===ui.cat}">
          <span class="dot" style="background:${catColor(c)}"></span>${esc(c)}
          ${b>0?`<span class="left ${rem<0?"over":""}">${rem<0?"−":""}${money(Math.abs(rem))}</span>`:""}</button>`;
      }).join("")}</div>
    </div>
    <div class="field" style="margin-bottom:16px"><span class="lbl">Paid with</span>
      <div class="chips">${METHODS.map(m=>`<button class="chip" data-method="${m}" aria-pressed="${m===ui.method}">${m}</button>`).join("")}</div></div>
    <div class="row2" style="margin-bottom:16px">
      <div class="field"><label class="lbl" for="date-btn">Date</label>
        <input type="hidden" id="date" value="${ui.draft.date||defaultDate()}">
        <button type="button" id="date-btn" class="picker" data-pickdate data-target="date" data-max="${ymd(new Date())}" data-label="Date">
          <span class="pv">${esc(dateLabel(ui.draft.date||defaultDate()))}</span><span class="cr">▾</span></button></div>
      <div class="field"><label class="lbl" for="note">Note</label>
        <input id="note" type="text" placeholder="optional" autocomplete="off" value="${esc(ui.draft.note)}"></div>
    </div>
    <button class="btn" data-act="addtx">Add ${ui.type==="expense"?"expense":"income"}</button>
    ${A.members.length>1?`<p class="hint" style="margin-top:10px">This goes into <b>${esc(A.ledger.name)}</b> under your name — everyone in the ledger will see it.</p>`:""}
  </section>
  <section class="panel"><p class="eyebrow">Latest</p>${txList(A.entries.slice(0,6),true)}</section>`;
}
function defaultDate(){
  const today=ymd(new Date());
  return monthOf(today)===ui.month?today:ui.month+"-"+pad(daysIn(ui.month));
}

function viewOverview(){
  const toggle=`<div class="seg" role="group" aria-label="Overview range" style="margin-bottom:14px">
    <button data-ovrange="month" aria-pressed="${ui.ovRange!=="all"}">This month</button>
    <button data-ovrange="all" aria-pressed="${ui.ovRange==="all"}">All time</button></div>`;
  return readOnlyNote()+toggle+(ui.ovRange==="all"?viewOverviewAll():viewOverviewMonth());
}
function viewOverviewMonth(){
  const s=stats(ui.month), st=settings(), b=st.budget||0;
  const pct=b>0?Math.min(100,s.spent/b*100):0, over=b>0&&s.spent>b, pace=s.cur?(s.elapsed/s.dim*100):100;
  const spent=catSpend(ui.month), cb=st.catBudgets||{};
  const cats=Object.entries(spent).sort((a,b)=>b[1]-a[1]);
  const enve=Object.keys(cb).filter(c=>cb[c]>0).sort((a,b)=>((spent[b]||0)/cb[b])-((spent[a]||0)/cb[a]));
  const maxCat=cats.length?cats[0][1]:1;
  const dim=s.dim, perDay=new Array(dim).fill(0);
  s.tx.filter(t=>t.type==="expense").forEach(t=>{const d=Number(t.date.slice(8,10)); if(d>=1&&d<=dim) perDay[d-1]+=t.amt});
  const maxDay=Math.max(1,...perDay);
  const[yy,mm]=ui.month.split("-").map(Number);
  const todayD=s.cur?Number(ymd(new Date()).slice(8,10)):-1;
  const tips=insights(ui.month);
  const ws=whoSpend(ui.month), whoRows=Object.entries(ws).sort((a,b)=>b[1]-a[1]);

  return `
  <section class="summary">
    <p class="eyebrow">Spent in ${esc(monthLabel(ui.month))}</p>
    <p class="bigfig">${money(s.spent)}${b>0?`<small>of ${money(b)}</small>`:""}</p>
    ${b>0?`<div class="meter ${over?"over":""}"><i style="width:${pct}%"></i>${s.cur?`<span class="pacer" style="left:${pace}%"></span>`:""}</div>
      <div class="meter-legend"><span>${over?`${money(s.spent-b)} over budget`:`${money(b-s.spent)} left`}</span>
      <span class="num">${Math.round(s.spent/b*100)}%${s.cur?` · day ${s.elapsed}/${s.dim}`:""}</span></div>`
    :`<p class="hint" style="margin-top:10px">No monthly budget set${isOwner()?" — add one under Data.":" — the ledger owner can set one."}</p>`}
    <dl class="statgrid">
      <div class="stat"><dt>Income</dt><dd class="up">${money(s.income)}</dd></div>
      <div class="stat"><dt>Net</dt><dd class="${s.net>=0?"up":"down"}">${s.net>=0?"+":"−"}${money(Math.abs(s.net))}</dd></div>
      <div class="stat"><dt>To goals</dt><dd>${money(s.saved)}</dd></div>
      <div class="stat"><dt>Save rate</dt><dd class="${s.rate>=20?"up":s.rate>=0?"":"down"}">${s.income>0?Math.round(s.rate)+"%":"—"}</dd></div>
      <div class="stat"><dt>${s.cur?"Projected":"Daily avg"}</dt><dd>${money(s.cur?s.projected:s.avg)}</dd></div>
    </dl>
  </section>

  ${whoRows.length>1?`<section class="panel">
    <h2 class="sec">Who spent what</h2>
    <div class="splitbar">${whoRows.map(([uid,v])=>`<i style="width:${v/s.spent*100}%;background:${personColor(uid)}"></i>`).join("")}</div>
    <div class="legend">${whoRows.map(([uid,v])=>`<span><i style="background:${personColor(uid)}"></i>${esc(memberName(uid))} <b class="num">${money(v)}</b></span>`).join("")}</div>
  </section>`:""}

  ${tips.length?`<section class="panel">
    <div class="sechead"><h2 class="sec">Where you could save</h2><span class="hint">from this ledger's entries</span></div>
    ${tips.map((t,i)=>`<div class="tip"><span class="mark ${t.warn?"warn":""}">${i+1}</span>
      <div><h4>${t.title}</h4><p>${t.body}</p>${t.save?`<p class="save">≈ ${money(t.save)} a month</p>`:""}</div></div>`).join("")}
    <p class="hint" style="margin-top:12px">Arithmetic on what was logged, not financial advice.</p>
  </section>`:""}

  ${enve.length?`<section class="panel">
    <div class="sechead"><h2 class="sec">Category budgets</h2>${isOwner()?`<button class="btn ghost sm" data-act="gotoenv">Edit</button>`:""}</div>
    <div class="catlist">${enve.map(c=>{
      const v=spent[c]||0, cap=cb[c], p=Math.min(100,v/cap*100), ov=v>cap;
      return `<div class="catrow">
        <div class="catname"><span class="dot" style="background:${catColor(c)}"></span><b>${esc(c)}</b></div>
        <div><span class="catamt" style="${ov?"color:var(--spend)":""}">${money(v)}</span> <span class="catpct">of ${money(cap)}</span></div>
        <div class="track"><i style="width:${p}%;background:${ov?"var(--spend)":catColor(c)}"></i>${s.cur?`<span class="cap" style="left:${s.elapsed/s.dim*100}%"></span>`:""}</div>
      </div>`;
    }).join("")}</div>
    <p class="hint" style="margin-top:12px">The tick marks where the month is — a bar past it is running hot.</p>
  </section>`:(isOwner()?`<section class="panel"><h2 class="sec">Category budgets</h2>
    <p class="hint">Cap a category — furniture, food, shopping — and it gets its own envelope here and on the Add screen.</p>
    <button class="btn ghost sm" data-act="gotoenv" style="margin-top:12px">Set category budgets</button></section>`:"")}

  <section class="panel">
    <h2 class="sec">Daily spend</h2>
    <div class="daychart" role="img" aria-label="Daily spending for ${esc(monthLabel(ui.month))}">
      ${perDay.map((v,i)=>{const dow=new Date(yy,mm-1,i+1).getDay(),we=dow===0||dow===6;
        return `<div class="daybar ${we?"weekend":""} ${i+1===todayD?"today":""}" title="${i+1} — ${money(v)}"><i style="height:${v?Math.max(3,v/maxDay*100):0}%"></i></div>`;}).join("")}
    </div>
    <div class="dayaxis"><span>1</span><span>${Math.ceil(dim/2)}</span><span>${dim}</span></div>
    <p class="hint" style="margin-top:8px">Peak day ${money(maxDay)} · shaded columns are weekends${s.cur?" · today in brick":""}</p>
  </section>

  <section class="panel">
    <h2 class="sec">Where it went</h2>
    ${cats.length?`<div class="catlist">${cats.map(([c,v])=>`
      <div class="catrow">
        <div class="catname"><span class="dot" style="background:${catColor(c)}"></span><b>${esc(c)}</b></div>
        <div><span class="catamt">${money(v)}</span> <span class="catpct">${Math.round(v/s.spent*100)}%</span></div>
        <div class="track"><i style="width:${v/maxCat*100}%;background:${catColor(c)}"></i></div>
      </div>`).join("")}</div>`:`<p class="empty">No expenses recorded this month.</p>`}
  </section>`;
}
function viewOverviewAll(){
  const s=allStats();
  const cats=Object.entries(txCat(s.tx)).sort((a,b)=>b[1]-a[1]);
  const maxCat=cats.length?cats[0][1]:1;
  const ws=txWho(s.tx), whoRows=Object.entries(ws).sort((a,b)=>b[1]-a[1]);
  const tms=trendMonths(12).map(monthFlow);
  const maxFlow=Math.max(1,...tms.map(f=>Math.max(f.income,f.expense)));
  const span=s.from===s.to?fmtDay(s.from,{day:"numeric",month:"short",year:"numeric"})
    :`${fmtDay(s.from,{month:"short",year:"numeric"})} – ${fmtDay(s.to,{month:"short",year:"numeric"})}`;

  return `
  <section class="summary">
    <p class="eyebrow">All time · ${esc(span)}</p>
    <p class="bigfig">${money(s.spent)}<small>spent across ${s.months} ${s.months===1?"month":"months"}</small></p>
    <dl class="statgrid">
      <div class="stat"><dt>Income</dt><dd class="up">${money(s.income)}</dd></div>
      <div class="stat"><dt>Net</dt><dd class="${s.net>=0?"up":"down"}">${s.net>=0?"+":"−"}${money(Math.abs(s.net))}</dd></div>
      <div class="stat"><dt>To goals</dt><dd>${money(s.saved)}</dd></div>
      <div class="stat"><dt>Save rate</dt><dd class="${s.rate>=20?"up":s.rate>=0?"":"down"}">${s.income>0?Math.round(s.rate)+"%":"—"}</dd></div>
      <div class="stat"><dt>Avg per month</dt><dd>${money(s.avgPerMonth)}</dd></div>
    </dl>
  </section>

  ${whoRows.length>1?`<section class="panel">
    <h2 class="sec">Who spent what</h2>
    <div class="splitbar">${whoRows.map(([uid,v])=>`<i style="width:${v/s.spent*100}%;background:${personColor(uid)}"></i>`).join("")}</div>
    <div class="legend">${whoRows.map(([uid,v])=>`<span><i style="background:${personColor(uid)}"></i>${esc(memberName(uid))} <b class="num">${money(v)}</b></span>`).join("")}</div>
  </section>`:""}

  <section class="panel">
    <div class="sechead"><h2 class="sec">Income vs spending</h2><span class="hint">last ${tms.length} ${tms.length===1?"month":"months"}</span></div>
    <div class="legend" style="margin-bottom:10px"><span><i style="background:var(--income)"></i>Income</span><span><i style="background:var(--spend)"></i>Spent</span></div>
    <div class="trendchart" role="img" aria-label="Income versus spending by month">
      ${tms.map(f=>`<div class="trendcol" title="${esc(monthLabel(f.month))} — income ${money(f.income)}, spent ${money(f.expense)}">
        <div class="trendbars"><i class="in" style="height:${f.income?Math.max(3,f.income/maxFlow*100):0}%"></i><i class="out" style="height:${f.expense?Math.max(3,f.expense/maxFlow*100):0}%"></i></div>
        <span class="trendlabel">${monthShort(f.month)}</span></div>`).join("")}
    </div>
  </section>

  <section class="panel">
    <h2 class="sec">Where it went</h2>
    ${cats.length?`<div class="catlist">${cats.map(([c,v])=>`
      <div class="catrow">
        <div class="catname"><span class="dot" style="background:${catColor(c)}"></span><b>${esc(c)}</b></div>
        <div><span class="catamt">${money(v)}</span> <span class="catpct">${Math.round(v/s.spent*100)}%</span></div>
        <div class="track"><i style="width:${v/maxCat*100}%;background:${catColor(c)}"></i></div>
      </div>`).join("")}</div>`:`<p class="empty">No expenses recorded yet.</p>`}
  </section>`;
}

function viewPlan(){
  const s=stats(ui.month), commit=monthlyCommitment();
  const emis=A.recur.filter(r=>r.kind==="emi").sort((a,b)=>(a.day||1)-(b.day||1));
  const others=A.recur.filter(r=>r.kind!=="emi").sort((a,b)=>(a.day||1)-(b.day||1));
  const outstanding=emis.reduce((a,r)=>a+emiProgress(r).outstanding,0);
  const gs=A.goals.slice().sort((a,b)=>((a.by||"9")<(b.by||"9")?-1:1));

  const emiRows=emis.map(r=>{
    const p=emiProgress(r), nd=nextDue(r), done=p.total&&p.left<=0;
    const sub=(p.total?`${p.paid} of ${p.total} paid${done?" · closed":` · ${p.left} left · ${money(p.outstanding)} outstanding`}`:"open-ended")
      +(nd&&!done?` · next ${fmtDay(nd,{day:"numeric",month:"short"})}`:"");
    return `<button class="commit" data-editrec="${r.id}">
      <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${catColor(r.cat)};flex:none"></span>
      <span class="body"><span class="t1">${esc(r.name)}</span><span class="t2">${esc(sub)}</span></span>
      <span class="amt">${money(r.amt)}<small>${pad(r.day)}th</small></span></button>`;
  }).join("");

  const otherRows=others.map(r=>{
    const nd=nextDue(r);
    const sub=`${KINDS[r.kind]||"Recurring"} · ${r.cat}`+(nd?` · next ${fmtDay(nd,{day:"numeric",month:"short"})}`:"")+(r.auto===false?" · manual":"");
    return `<button class="commit" data-editrec="${r.id}">
      <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${catColor(r.cat)};flex:none"></span>
      <span class="body"><span class="t1">${esc(r.name)}</span><span class="t2">${esc(sub)}</span></span>
      <span class="amt">${money(r.amt)}<small>${pad(r.day)}th</small></span></button>`;
  }).join("");

  const goalCards=gs.map(g=>{
    const n=goalNeed(g), p=g.target>0?Math.min(100,(g.saved||0)/g.target*100):0;
    const thisMonth=(g.hist||[]).filter(h=>monthOf(h.d)===monthOf(ymd(new Date()))).reduce((a,b)=>a+b.a,0);
    const st=n.rem<=0?["good","Funded"]:!g.by?["","No date set"]:n.months<=0?["bad","Due now"]
      :thisMonth>=n.perMonth?["good","On track"]:["warn",money(n.perMonth)+"/mo needed"];
    const mine=canModify(g);
    return `<div class="goal">
      <div class="goalhead"><span class="goalname">${esc(g.name)}</span>
        <span class="goalfig"><b>${money(g.saved||0)}</b> of ${money(g.target)}</span></div>
      <div class="track" style="margin-top:9px"><i style="width:${p}%;background:var(--accent)"></i></div>
      <div class="goalfoot">
        <span class="badge ${st[0]}">${st[1]}</span>
        <span class="hint num">${n.rem>0?money(n.rem)+" to go":"complete"}${g.by?` · by ${fmtDay(g.by,{month:"short",year:"numeric"})}`:""}${n.months>0?` · ${n.months} mo`:""}</span>
        <span style="display:flex;gap:8px">
          ${canWrite()?`<button class="btn ghost sm" data-addmoney="${g.id}">Add money</button>`:""}
          ${mine?`<button class="btn ghost sm" data-editgoal="${g.id}">Edit</button>`:`<span class="hint">by ${esc(memberName(g.uid))}</span>`}</span>
      </div></div>`;
  }).join("");

  return `
  ${readOnlyNote()}
  <section class="panel">
    <div class="sechead"><h2 class="sec">Savings goals</h2>${canWrite()?`<button class="btn ghost sm" data-act="newgoal">New goal</button>`:""}</div>
    ${gs.length?goalCards:`<div class="empty"><p>No goals yet.</p>
      <p class="hint">A car, a sofa, an emergency fund — set a target and a date and this works out the monthly number.</p></div>`}
  </section>

  <section class="panel">
    <div class="sechead"><h2 class="sec">EMIs &amp; recurring</h2>${canWrite()?`<button class="btn ghost sm" data-act="newrec">Add</button>`:""}</div>
    <dl class="statgrid two" style="margin-top:0">
      <div class="stat"><dt>Committed each month</dt><dd>${money(commit)}</dd></div>
      <div class="stat"><dt>Loan outstanding</dt><dd>${outstanding?money(outstanding):"—"}</dd></div>
    </dl>
    ${s.income>0?`<p class="hint" style="margin-top:10px">That's ${Math.round(commit/s.income*100)}% of this month's income spoken for before anything discretionary.</p>`:""}
    ${emis.length?`<p class="eyebrow" style="margin-top:18px">Loans</p>${emiRows}`:""}
    ${others.length?`<p class="eyebrow" style="margin-top:18px">Bills &amp; subscriptions</p>${otherRows}`:""}
    ${!A.recur.length?`<div class="empty"><p>Nothing recurring yet.</p>
      <p class="hint">Add an EMI, rent, or a subscription and it posts itself to the ledger on its due date.</p></div>`
      :`<p class="hint" style="margin-top:12px">These post themselves on their due date, backdated up to two years if one is added late.</p>`}
  </section>`;
}

function viewHistory(){
  const s=stats(ui.month);
  let list=s.tx.slice();
  if(ui.filterCat) list=list.filter(t=>t.cat===ui.filterCat);
  if(ui.filterWho) list=list.filter(t=>t.uid===ui.filterWho);
  if(ui.q){ const q=ui.q.toLowerCase();
    list=list.filter(t=>(t.note||"").toLowerCase().includes(q)||String(t.cat).toLowerCase().includes(q)||String(t.amt).includes(q)); }
  list.sort(cmpTx);
  const present=[...new Set(s.tx.map(t=>t.cat))].sort();
  const total=list.filter(t=>t.type==="expense").reduce((a,b)=>a+b.amt,0);
  return `
  <section class="panel">
    <div class="field" style="margin-bottom:12px">
      <input id="q" type="text" placeholder="Search notes, categories, amounts" value="${esc(ui.q)}" autocomplete="off"></div>
    ${A.members.length>1?`<div class="chips" style="margin-bottom:10px">
      <button class="chip" data-fwho="" aria-pressed="${ui.filterWho===""}">Everyone</button>
      ${A.members.map(m=>`<button class="chip" data-fwho="${esc(m.uid)}" aria-pressed="${ui.filterWho===m.uid}">
        <span class="dot" style="background:${personColor(m.uid)}"></span>${esc((m.name||m.email||"").split(" ")[0])}</button>`).join("")}</div>`:""}
    <div class="chips">
      <button class="chip" data-fcat="" aria-pressed="${ui.filterCat===""}">All</button>
      ${present.map(c=>`<button class="chip" data-fcat="${esc(c)}" aria-pressed="${ui.filterCat===c}">
        <span class="dot" style="background:${catColor(c)}"></span>${esc(c)}</button>`).join("")}</div>
    <p class="hint" style="margin-top:12px">${list.length} ${list.length===1?"entry":"entries"} · ${money(total)} of expenses</p>
  </section>
  <section class="panel">${txList(list,false)}</section>`;
}
function cmpTx(a,b){ return a.date===b.date?(b.u||0)-(a.u||0):(a.date<b.date?1:-1); }
function txList(list,flat){
  if(!list.length) return `<div class="empty"><p>Nothing here yet.</p><p class="hint">Entries added to this ledger show up in this list.</p></div>`;
  if(flat) return list.map(txRow).join("");
  const groups={};
  list.forEach(t=>{(groups[t.date]=groups[t.date]||[]).push(t)});
  return Object.keys(groups).sort().reverse().map(d=>{
    const day=groups[d], tot=day.filter(t=>t.type==="expense").reduce((a,b)=>a+b.amt,0);
    return `<div class="daygroup"><div class="dayhead">
      <span class="d">${esc(fmtDay(d,{weekday:"short",day:"numeric",month:"short"}))}</span>
      <span class="t">${tot?money(tot):"—"}</span></div>${day.map(txRow).join("")}</div>`;
  }).join("");
}
function txRow(t){
  const multi=A.members.length>1;
  return `<button class="tx" data-tx="${t.id}">
    <span class="dot" style="background:${catColor(t.cat)}"></span>
    <span class="body"><span class="t1">${esc(t.note||t.cat)}</span>
      <span class="t2">${esc(t.cat)}${t.method?" · "+esc(t.method):""}${t.rec?" · auto":""}
        ${multi?`<span class="who"><i style="width:6px;height:6px;border-radius:50%;background:${personColor(t.uid)};display:inline-block"></i>${esc((memberName(t.uid)||"").split(" ")[0])}</span>`:""}</span></span>
    <span class="amt ${t.type==="income"?"in":""}">${t.type==="income"?"+":"−"}${money(t.amt)}</span></button>`;
}

function viewPeople(){
  const owner=A.ledger.ownerUid;
  const link=location.origin+location.pathname+"#join="+A.lid;
  const rows=A.members.slice().sort((a,b)=>(a.uid===owner?-1:b.uid===owner?1:0)).map(m=>{
    const isMe=m.uid===A.me.uid, isTheOwner=m.uid===owner;
    return `<div class="person">
      <span class="avatar">${m.photo?`<img src="${esc(m.photo)}" alt="" referrerpolicy="no-referrer">`:esc((m.name||m.email||"?").trim()[0].toUpperCase())}</span>
      <span class="body"><span class="nm">${esc(m.name||m.email)}${isMe?" (you)":""}</span>
        <span class="em">${esc(m.email||"")}</span></span>
      ${isTheOwner?`<span class="rolechip owner">owner</span>`
        :isOwner()?`<input type="hidden" id="role-${esc(m.uid)}" value="${esc(m.role)}">
          <button type="button" class="picker sm" data-pick data-target="role-${esc(m.uid)}" data-role="${esc(m.uid)}" data-label="Access"
            data-options="${esc(JSON.stringify([{v:"editor",l:"Can add"},{v:"viewer",l:"View only"}]))}">
            <span class="pv">${m.role==="viewer"?"View only":"Can add"}</span><span class="cr">▾</span></button>
          <button class="iconbtn" data-remove="${esc(m.uid)}" aria-label="Remove ${esc(m.name||m.email)}">×</button>`
        :`<span class="rolechip ${m.role==="viewer"?"viewer":""}">${esc(m.role)}</span>`}
    </div>`;
  }).join("");

  return `
  <section class="panel">
    <h2 class="sec">${esc(A.ledger.name)}</h2>
    <p class="hint" style="margin-bottom:14px">${A.members.length===1
      ? "Only you can see this ledger. Invite someone below and they'll need to sign in with the exact Google account you invite."
      : `${A.members.length} people can see this ledger.`}</p>
    ${rows}
  </section>

  ${isOwner()?`<section class="panel">
    <h2 class="sec">Invite someone</h2>
    <div class="row2" style="margin-bottom:12px">
      <div class="field"><label class="lbl" for="i-email">Their Google email</label>
        <input id="i-email" type="email" inputmode="email" placeholder="name@gmail.com" autocomplete="off"></div>
      <div class="field"><label class="lbl" for="i-role-btn">Access</label>
        <input type="hidden" id="i-role" value="editor">
        <button type="button" id="i-role-btn" class="picker" data-pick data-target="i-role" data-label="Access"
          data-options="${esc(JSON.stringify([{v:"editor",l:"Can add entries"},{v:"viewer",l:"View only"}]))}">
          <span class="pv">Can add entries</span><span class="cr">▾</span></button></div>
    </div>
    <button class="btn" data-act="invite">Create invite</button>
    ${A.invites.length?`<p class="eyebrow" style="margin-top:20px">Waiting to be accepted</p>
      ${A.invites.map(i=>`<div class="invite"><span class="em">${esc(i.email)}</span>
        <span class="rolechip ${i.role==="viewer"?"viewer":""}">${esc(i.role==="viewer"?"view only":"can add")}</span>
        <button class="iconbtn" data-uninvite="${esc(i.email)}" aria-label="Withdraw invite">×</button></div>`).join("")}
      <div class="field" style="margin-top:14px"><span class="lbl">Send them this link</span>
        <input id="joinlink" type="text" readonly value="${esc(link)}" onclick="this.select()"></div>
      <button class="btn ghost sm" data-act="copylink" style="margin-top:10px">Copy invite link</button>`:""}
    <p class="hint" style="margin-top:14px">An invite only works for the email address you type, and only after that person signs in with that Google account.</p>
  </section>

  <section class="panel">
    <h2 class="sec">What each level can do</h2>
    <div class="kv"><span><b>Owner</b><br><span class="hint">You. Budgets, categories, members, and every entry including other people's.</span></span></div>
    <div class="kv"><span><b>Can add</b><br><span class="hint">Adds entries, goals and commitments. Can edit or delete only what they added — never anyone else's.</span></span></div>
    <div class="kv"><span><b>View only</b><br><span class="hint">Reads everything, changes nothing.</span></span></div>
    <p class="hint" style="margin-top:12px">These are enforced by the database itself, not just hidden in the app.</p>
  </section>`:`<section class="panel">
    <h2 class="sec">Your access</h2>
    <p class="hint">You're ${myRole()==="viewer"?"a viewer here — you can read everything but not change anything":"an editor here — you can add entries and change the ones you added, but not anyone else's"}.
      Only ${esc(memberName(owner))} can change budgets, categories and who's in the ledger.</p>
    <button class="btn danger sm" data-act="leave" style="margin-top:14px">Leave this ledger</button>
  </section>`}`;
}

function viewData(){
  const st=settings(), cb=st.catBudgets||{};
  const months=[...new Set(A.entries.map(t=>monthOf(t.date)))].sort().reverse();
  return `
  ${isOwner()?`<section class="panel">
    <h2 class="sec">Monthly budget</h2>
    <div class="row2">
      <div class="field"><label class="lbl" for="budget">Overall cap (₹)</label>
        <input id="budget" type="number" inputmode="numeric" min="0" step="500" value="${st.budget||""}" placeholder="e.g. 45000"></div>
      <div class="field"><span class="lbl">&nbsp;</span><button class="btn ghost" data-act="savebudget">Save</button></div>
    </div>
  </section>

  <section class="panel" id="envelopes">
    <h2 class="sec">Category budgets</h2>
    <p class="hint" style="margin-bottom:12px">Leave a category at zero to skip it. Envelopes total
      <b class="num">${money(Object.values(cb).reduce((a,b)=>a+(b||0),0))}</b>.</p>
    <div class="catlist">${st.cats.map(c=>`
      <div style="display:flex;align-items:center;gap:10px">
        <span class="dot" style="width:9px;height:9px;border-radius:50%;background:${catColor(c)};flex:none"></span>
        <span style="flex:1;font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c)}</span>
        <input type="number" inputmode="numeric" min="0" step="500" data-cbudget="${esc(c)}" value="${cb[c]||""}" placeholder="0" style="width:110px;text-align:right" class="num">
      </div>`).join("")}</div>
    <button class="btn ghost sm" data-act="savecb" style="margin-top:14px">Save category budgets</button>
  </section>

  <section class="panel">
    <h2 class="sec">Categories</h2>
    <div class="chips">${st.cats.map(c=>`<span class="chip"><span class="dot" style="background:${catColor(c)}"></span>${esc(c)}
      <button data-delcat="${esc(c)}" aria-label="Remove ${esc(c)}" style="color:var(--faint);font-size:15px;line-height:1">×</button></span>`).join("")}</div>
    <div class="row2" style="margin-top:12px">
      <div class="field"><input id="newcat" type="text" placeholder="New expense category" autocomplete="off"></div>
      <div class="field"><button class="btn ghost" data-act="addcat">Add category</button></div>
    </div>
  </section>`:""}

  <section class="panel">
    <h2 class="sec">Export</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn ghost sm" data-act="exportcsv">Download CSV</button>
      <button class="btn ghost sm" data-act="exportjson">Download JSON</button>
    </div>
    <p class="hint" style="margin-top:10px">Everything you can see in this ledger, as a file. Your data is never locked in.</p>
  </section>

  <section class="panel">
    <h2 class="sec">This ledger</h2>
    <div class="kv"><span>Entries loaded</span><b class="num">${A.entries.length}</b></div>
    <div class="kv"><span>Months covered</span><b class="num">${months.length?esc(monthShort(months[months.length-1]))+" → "+esc(monthShort(months[0])):"—"}</b></div>
    <div class="kv"><span>People</span><b class="num">${A.members.length}</b></div>
    <div class="kv"><span>Goals</span><b class="num">${A.goals.length}</b></div>
    <div class="kv"><span>Recurring items</span><b class="num">${A.recur.length}</b></div>
    <p class="hint" style="margin-top:10px">The app keeps the most recent 2,000 entries loaded — plenty for years of a household.</p>
    ${isOwner()&&A.ledgers.length>1?`<button class="btn danger sm" data-act="delledger" style="margin-top:14px">Delete this ledger</button>`:""}
  </section>

  ${A.deleted.length?`<section class="panel">
    <h2 class="sec">Recently deleted</h2>
    <p class="hint" style="margin-bottom:12px">Already hidden from everyone. Kept for ${GRACE_DAYS} days in case it was a mistake, then cleared from the database automatically the next time you open the app.</p>
    ${A.deleted.map(l=>{
      const left=daysLeft(l);
      return `<div class="person">
        <span class="body"><span class="nm">${esc(l.name)}</span>
          <span class="em">Deleted ${esc(fmtDay(l.deletedAt,{day:"numeric",month:"short"}))} · ${left?`${left} day${left===1?"":"s"} left`:"clearing now"}</span></span>
        <button class="btn ghost sm" data-restore="${esc(l.id)}">Restore</button>
        <button class="btn danger sm" data-purge="${esc(l.id)}">Clear now</button>
      </div>`;
    }).join("")}
  </section>`:""}

  ${A.seed?`<section class="panel">
    <h2 class="sec">Who can use this app</h2>
    <p class="hint" style="margin-bottom:12px">The app is invite-only. Anyone signing in without being on this list is told to ask for an invite. You're the only account that can edit it.</p>
    ${A.allowList.map(a=>`<div class="person">
      <span class="body"><span class="nm">${esc(a.email)}${a.seed?" (you)":""}</span>
        <span class="em">${a.seed?"Runs this app":"Enrolled by invite"}</span></span>
      ${a.seed?`<span class="rolechip owner">seed</span>`
        :`<button class="btn ghost sm" data-share="${esc(a.email)}">Share</button>
          <button class="iconbtn" data-unallow="${esc(a.email)}" aria-label="Remove ${esc(a.email)}">×</button>`}
    </div>`).join("")}
    <div class="row2" style="margin-top:14px">
      <div class="field"><input id="a-email" type="email" inputmode="email" placeholder="name@gmail.com" autocomplete="off"></div>
      <div class="field"><button class="btn ghost" data-act="allow">Let them in</button></div>
    </div>
    <div class="kv" style="margin-top:8px"><span>Anyone can invite new people<br>
      <span class="hint">Off means only you can enrol someone new. Ledger owners can still invite people who are already on the list.</span></span>
      <button class="switch" id="openinv" role="switch" aria-checked="${A.openInvites}" aria-label="Anyone can invite new people"><i></i></button></div>
    <p class="hint" style="margin-top:12px">Removing someone here stops them starting new ledgers. It does not remove them from ledgers they're already in — do that from the People tab of each ledger.</p>
  </section>`:""}

  <section class="panel">
    <h2 class="sec">Account</h2>
    <div class="kv"><span>Signed in as</span><b>${esc(A.me.email||"")}</b></div>
    ${!A.seed?`<div class="kv"><span>Access</span><b>Invited</b></div>`:""}
    <button class="btn ghost sm" data-act="signout" style="margin-top:14px">Sign out</button>
  </section>`;
}

/* ---------------- sheets ---------------- */
function sheet(html){
  document.getElementById("modal").innerHTML=`<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  document.getElementById("scrim").addEventListener("click",e=>{ if(e.target.id==="scrim") closeSheet(); });
}
function closeSheet(){ ui.editing=null; document.getElementById("modal").innerHTML=""; }
function head(t){ return `<div class="sheethead"><h3>${t}</h3><button class="iconbtn" data-act="close" aria-label="Close">×</button></div>`; }

function openLedgerSwitcher(){
  sheet(`${head("Your ledgers")}
    ${A.ledgers.map(l=>`<button class="person" data-openledger="${esc(l.id)}" style="width:100%;text-align:left;border:none;background:${l.id===A.lid?"var(--sunk)":"none"}">
      <span class="body"><span class="nm">${esc(l.name)}</span>
        <span class="em">${l.ownerUid===A.me.uid?"You own this":"Shared with you"}</span></span>
      <span class="rolechip ${l.ownerUid===A.me.uid?"owner":l.role==="viewer"?"viewer":""}">${l.ownerUid===A.me.uid?"owner":esc(l.role)}</span>
    </button>`).join("")}
    <div class="field" style="margin-top:16px"><label class="lbl" for="nl-name">Start another ledger</label>
      <input id="nl-name" type="text" placeholder="Family, Household, Trip to Goa" autocomplete="off"></div>
    <button class="btn" data-act="newledger" style="margin-top:10px">Create ledger</button>
    <p class="hint" style="margin-top:12px">A new ledger is private to you until you invite someone. Keep your own spending in one and shared household costs in another.</p>`);
}
function openTx(id){
  const t=A.entries.find(x=>x.id===id); if(!t) return;
  ui.editing=id;
  const mine=canModify(t), st=settings();
  const cats=t.type==="expense"?st.cats:st.incomeCats;
  const opts=[...new Set(cats.concat([t.cat]))];
  if(!mine) return sheet(`${head("Entry")}
    <div class="kv"><span>Amount</span><b class="num">${money2(t.amt)}</b></div>
    <div class="kv"><span>Category</span><b>${esc(t.cat)}</b></div>
    <div class="kv"><span>Date</span><b>${esc(fmtDay(t.date,{day:"numeric",month:"long",year:"numeric"}))}</b></div>
    <div class="kv"><span>Paid with</span><b>${esc(t.method||"—")}</b></div>
    <div class="kv"><span>Note</span><b>${esc(t.note||"—")}</b></div>
    <div class="kv"><span>Added by</span><b>${esc(memberName(t.uid))}</b></div>
    <p class="hint" style="margin-top:14px">${t.uid===A.me.uid?"":"This isn't your entry, so you can't change it. "}Only ${esc(memberName(A.ledger.ownerUid))} can edit or remove other people's entries.</p>`);
  sheet(`${head("Edit entry")}
    ${t.rec?`<p class="hint" style="margin:-6px 0 12px">Posted automatically by a recurring item. Editing changes only this month's entry.</p>`:""}
    <div class="row2" style="margin-bottom:12px">
      <div class="field"><label class="lbl" for="e-amt">Amount (₹)</label><input id="e-amt" type="text" inputmode="decimal" value="${t.amt}"></div>
      <div class="field"><label class="lbl" for="e-date-btn">Date</label>
        <input type="hidden" id="e-date" value="${t.date}">
        <button type="button" id="e-date-btn" class="picker" data-pickdate data-target="e-date" data-max="${ymd(new Date())}" data-label="Date">
          <span class="pv">${esc(dateLabel(t.date))}</span><span class="cr">▾</span></button></div></div>
    <div class="row2" style="margin-bottom:12px">
      <div class="field"><label class="lbl" for="e-cat-btn">Category</label>
        <input type="hidden" id="e-cat" value="${esc(t.cat)}">
        <button type="button" id="e-cat-btn" class="picker" data-pick data-target="e-cat" data-label="Category"
          data-options="${esc(JSON.stringify(opts.map(c=>({v:c,l:c}))))}">
          <span class="pv">${esc(t.cat)}</span><span class="cr">▾</span></button></div>
      <div class="field"><label class="lbl" for="e-method-btn">Paid with</label>
        <input type="hidden" id="e-method" value="${esc(t.method)}">
        <button type="button" id="e-method-btn" class="picker" data-pick data-target="e-method" data-label="Paid with"
          data-options="${esc(JSON.stringify(METHODS.map(m=>({v:m,l:m}))))}">
          <span class="pv">${esc(t.method)}</span><span class="cr">▾</span></button></div></div>
    <div class="field" style="margin-bottom:16px"><label class="lbl" for="e-note">Note</label>
      <input id="e-note" type="text" value="${esc(t.note||"")}"></div>
    ${t.uid!==A.me.uid?`<p class="hint" style="margin-bottom:12px">Added by ${esc(memberName(t.uid))} — you're editing it as the ledger owner.</p>`:""}
    <div style="display:flex;gap:10px">
      <button class="btn" data-act="savetx">Save changes</button>
      <button class="btn danger" data-act="deltx" style="width:auto;white-space:nowrap">Delete</button></div>`);
  document.getElementById("e-amt").focus();
}
function openGoal(id){
  const g=id?A.goals.find(x=>x.id===id):null;
  if(g&&!canModify(g)) return toast("Only "+memberName(g.uid)+" or the ledger owner can change that goal");
  ui.editing=id||null;
  sheet(`${head(g?"Edit goal":"New goal")}
    <div class="field" style="margin-bottom:12px"><label class="lbl" for="g-name">What are you saving for</label>
      <input id="g-name" type="text" value="${g?esc(g.name):""}" placeholder="Car down payment" autocomplete="off"></div>
    <div class="row2" style="margin-bottom:12px">
      <div class="field"><label class="lbl" for="g-target">Target (₹)</label>
        <input id="g-target" type="number" inputmode="numeric" min="0" step="1000" value="${g?g.target:""}" placeholder="300000"></div>
      <div class="field"><label class="lbl" for="g-saved">Already saved (₹)</label>
        <input id="g-saved" type="number" inputmode="numeric" min="0" step="1000" value="${g?(g.saved||0):0}"></div></div>
    <div class="field" style="margin-bottom:16px"><label class="lbl" for="g-by-btn">Target date</label>
      <input type="hidden" id="g-by" value="${g&&g.by?g.by:""}">
      <button type="button" id="g-by-btn" class="picker" data-pickdate data-target="g-by" data-label="Target date" data-clearable="1" data-placeholder="No date set">
        <span class="pv${g&&g.by?"":" ph"}">${g&&g.by?esc(dateLabel(g.by)):"No date set"}</span><span class="cr">▾</span></button></div>
    <div style="display:flex;gap:10px">
      <button class="btn" data-act="savegoal">${g?"Save goal":"Create goal"}</button>
      ${g?`<button class="btn danger" data-act="delgoal" style="width:auto;white-space:nowrap">Delete</button>`:""}</div>`);
  document.getElementById("g-name").focus();
}
function openMoney(id){
  const g=A.goals.find(x=>x.id===id); if(!g) return;
  ui.editing=id;
  const n=goalNeed(g);
  sheet(`${head("Add to "+esc(g.name))}
    <p class="hint" style="margin:-6px 0 14px">${money(n.rem)} still to go${n.perMonth>0?` · ${money(n.perMonth)} a month hits the date`:""}.</p>
    <div class="row2" style="margin-bottom:16px">
      <div class="field"><label class="lbl" for="m-amt">Amount (₹)</label>
        <input id="m-amt" type="text" inputmode="decimal" value="${n.perMonth>0?Math.round(n.perMonth):""}" placeholder="0"></div>
      <div class="field"><label class="lbl" for="m-date-btn">Date</label>
        <input type="hidden" id="m-date" value="${ymd(new Date())}">
        <button type="button" id="m-date-btn" class="picker" data-pickdate data-target="m-date" data-max="${ymd(new Date())}" data-label="Date">
          <span class="pv">${esc(dateLabel(ymd(new Date())))}</span><span class="cr">▾</span></button></div></div>
    <button class="btn" data-act="savemoney">Add to goal</button>
    <p class="hint" style="margin-top:12px">Money moved into savings isn't counted as spending — it shows up in the save rate instead.</p>`);
  document.getElementById("m-amt").focus();
}
function openRec(id){
  const r=id?A.recur.find(x=>x.id===id):null;
  if(r&&!canModify(r)) return toast("Only "+memberName(r.uid)+" or the ledger owner can change that");
  ui.editing=id||null;
  const st=settings(), cur=monthOf(ymd(new Date()));
  const defKind=r?r.kind:Object.keys(KINDS)[0];
  const defCat=r?r.cat:(st.cats.includes("EMI & Loans")?"EMI & Loans":st.cats[0]);
  const defMethod=r?r.method:(METHODS.includes("Netbanking")?"Netbanking":METHODS[0]);
  sheet(`${head(r?"Edit recurring item":"New recurring item")}
    <div class="field" style="margin-bottom:12px"><label class="lbl" for="r-name">Name</label>
      <input id="r-name" type="text" value="${r?esc(r.name):""}" placeholder="Car loan / Netflix / Rent" autocomplete="off"></div>
    <div class="row3" style="margin-bottom:12px">
      <div class="field"><label class="lbl" for="r-amt">Amount (₹)</label>
        <input id="r-amt" type="number" inputmode="numeric" min="0" step="100" value="${r?r.amt:""}"></div>
      <div class="field"><label class="lbl" for="r-day">Day of month</label>
        <input id="r-day" type="number" inputmode="numeric" min="1" max="31" value="${r?r.day:5}"></div>
      <div class="field"><label class="lbl" for="r-kind-btn">Type</label>
        <input type="hidden" id="r-kind" value="${esc(defKind)}">
        <button type="button" id="r-kind-btn" class="picker" data-pick data-target="r-kind" data-label="Type"
          data-options="${esc(JSON.stringify(Object.entries(KINDS).map(([k,v])=>({v:k,l:v}))))}">
          <span class="pv">${esc(KINDS[defKind])}</span><span class="cr">▾</span></button></div></div>
    <div class="row2" style="margin-bottom:12px">
      <div class="field"><label class="lbl" for="r-cat-btn">Category</label>
        <input type="hidden" id="r-cat" value="${esc(defCat)}">
        <button type="button" id="r-cat-btn" class="picker" data-pick data-target="r-cat" data-label="Category"
          data-options="${esc(JSON.stringify(st.cats.map(c=>({v:c,l:c}))))}">
          <span class="pv">${esc(defCat)}</span><span class="cr">▾</span></button></div>
      <div class="field"><label class="lbl" for="r-method-btn">Paid with</label>
        <input type="hidden" id="r-method" value="${esc(defMethod)}">
        <button type="button" id="r-method-btn" class="picker" data-pick data-target="r-method" data-label="Paid with"
          data-options="${esc(JSON.stringify(METHODS.map(m=>({v:m,l:m}))))}">
          <span class="pv">${esc(defMethod)}</span><span class="cr">▾</span></button></div></div>
    <div class="row2" style="margin-bottom:12px">
      <div class="field"><label class="lbl" for="r-start-btn">First payment</label>
        <input type="hidden" id="r-start" value="${r?r.start:cur}">
        <button type="button" id="r-start-btn" class="picker" data-pickmonth data-target="r-start" data-label="First payment">
          <span class="pv">${esc(monthShort(r?r.start:cur))}</span><span class="cr">▾</span></button></div>
      <div class="field"><label class="lbl" for="r-count">Total instalments</label>
        <input id="r-count" type="number" inputmode="numeric" min="0" value="${r&&r.count?r.count:""}" placeholder="blank = ongoing"></div></div>
    <div class="kv" style="margin-bottom:14px"><span>Post it to the ledger automatically<br>
      <span class="hint">Off if you'd rather log it by hand</span></span>
      <button class="switch" id="r-auto" role="switch" aria-checked="${r?String(r.auto!==false):"true"}" aria-label="Post automatically"><i></i></button></div>
    <div style="display:flex;gap:10px">
      <button class="btn" data-act="saverec">${r?"Save":"Add item"}</button>
      ${r?`<button class="btn danger" data-act="delrec" style="width:auto;white-space:nowrap">Delete</button>`:""}</div>
    ${r?`<p class="hint" style="margin-top:12px">Deleting stops future postings; entries already in the ledger stay.</p>`:""}`);
  document.getElementById("r-name").focus();
}

/* ---------------- pickers (iOS-style dropdown & calendar) ---------------
   Native <select> and <input type=date/month> render as whatever the OS
   gives you. These stand in a hidden input (so val() reads keep working
   unchanged) plus a button that opens a bottom sheet stacked on top of
   #modal — never replacing it, so a picker opened from inside an edit
   sheet doesn't wipe whatever the person already typed in other fields. */
function pickHead(t){ return `<div class="sheethead"><h3>${t}</h3><button type="button" class="iconbtn" data-act="closepicker" aria-label="Close">×</button></div>`; }
function pickerOverlay(inner){
  const ex=document.querySelector("[data-picker-scrim]");
  if(ex){ ex.querySelector(".picker-sheet").innerHTML=inner; return; }
  document.getElementById("modal").insertAdjacentHTML("beforeend",
    `<div class="scrim picker-scrim" data-picker-scrim><div class="sheet picker-sheet" role="dialog" aria-modal="true">${inner}</div></div>`);
  document.querySelector("[data-picker-scrim]").addEventListener("click",e=>{
    if(e.target.hasAttribute("data-picker-scrim")) closePicker();
  });
}
function closePicker(){ const ov=document.querySelector("[data-picker-scrim]"); if(ov) ov.remove(); ui.picker=null; }

function setPicked(target,value,label){
  const inp=document.getElementById(target); if(inp) inp.value=value;
  const btn=document.querySelector(`[data-target="${target}"]`);
  if(btn){ const pv=btn.querySelector(".pv"); if(pv){
    pv.textContent=label||btn.dataset.placeholder||""; pv.classList.toggle("ph",!label);
  }}
  if(target==="date") ui.draft.date=value;
}

function openOptionPicker(trg){
  const target=trg.dataset.target, opts=JSON.parse(trg.dataset.options), cur=document.getElementById(target).value;
  ui.picker={kind:"opt",target,opts,roleUid:trg.dataset.role||null};
  pickerOverlay(`${pickHead(esc(trg.dataset.label||"Choose"))}
    <div class="picklist">${opts.map(o=>`<button type="button" class="pickrow" data-pickval="${esc(o.v)}" aria-pressed="${o.v===cur}">
      <span>${esc(o.l)}</span>${o.v===cur?`<span class="pickcheck">✓</span>`:""}</button>`).join("")}</div>`);
}
function choosePickval(el){
  const p=ui.picker; if(!p) return;
  const chosen=p.opts.find(o=>o.v===el.dataset.pickval);
  setPicked(p.target,el.dataset.pickval,chosen?chosen.l:el.dataset.pickval);
  if(p.roleUid) changeRole(p.roleUid,el.dataset.pickval);
  closePicker();
}

const DOWS=["S","M","T","W","T","F","S"];
function calGrid(month,cur,max,min){
  const[y,mo]=month.split("-").map(Number);
  const startDow=new Date(y,mo-1,1).getDay(), dim=daysIn(month), todayS=ymd(new Date());
  const cells=[];
  for(let i=0;i<startDow;i++) cells.push(`<span class="calcell empty"></span>`);
  for(let d=1;d<=dim;d++){
    const ds=month+"-"+pad(d), dis=(max&&ds>max)||(min&&ds<min);
    cells.push(`<button type="button" class="calcell${ds===cur?" sel":""}${ds===todayS?" today":""}" ${dis?"disabled":""} data-day="${ds}">${d}</button>`);
  }
  return cells.join("");
}
function dateLabel(ds){ return fmtDay(ds,{day:"numeric",month:"short",year:"numeric"}); }
function openDatePicker(trg){
  const target=trg.dataset.target, cur=document.getElementById(target).value||ymd(new Date());
  ui.picker={kind:"date",target,month:monthOf(cur),cur,max:trg.dataset.max||"",min:trg.dataset.min||"",
    label:trg.dataset.label||"Date",clearable:trg.dataset.clearable==="1"};
  renderCalPicker();
}
function renderCalPicker(){
  const p=ui.picker;
  pickerOverlay(`${pickHead(esc(p.label))}
    <div class="calnav">
      <button type="button" data-calnav="-1" aria-label="Previous month">‹</button>
      <span class="calmonth">${esc(monthLabel(p.month))}</span>
      <button type="button" data-calnav="1" aria-label="Next month" ${p.max&&shiftMonth(p.month,1)>monthOf(p.max)?"disabled":""}>›</button>
    </div>
    <div class="calgrid">${DOWS.map(d=>`<span class="caldow">${d}</span>`).join("")}${calGrid(p.month,p.cur,p.max,p.min)}</div>
    <div class="calfoot">
      <button type="button" class="btn ghost sm" data-act="caltoday">Today</button>
      ${p.clearable?`<button type="button" class="btn ghost sm" data-act="calclear">No date</button>`:""}
    </div>`);
}
function chooseDay(ds){ const p=ui.picker; if(!p) return; setPicked(p.target,ds,dateLabel(ds)); closePicker(); }
function pickToday(){ const p=ui.picker; if(!p||p.kind!=="date") return; const ds=ymd(new Date()); setPicked(p.target,ds,dateLabel(ds)); closePicker(); }
function pickClear(){ const p=ui.picker; if(!p) return; setPicked(p.target,"",""); closePicker(); }

function openMonthPicker(trg){
  const target=trg.dataset.target, cur=document.getElementById(target).value||monthOf(ymd(new Date()));
  ui.picker={kind:"month",target,year:Number(cur.slice(0,4)),cur,label:trg.dataset.label||"Month"};
  renderMonthPicker();
}
function renderMonthPicker(){
  const p=ui.picker;
  pickerOverlay(`${pickHead(esc(p.label))}
    <div class="calnav">
      <button type="button" data-calnavyear="-1" aria-label="Previous year">‹</button>
      <span class="calmonth">${p.year}</span>
      <button type="button" data-calnavyear="1" aria-label="Next year">›</button>
    </div>
    <div class="calgrid months">${MONS.map((m,i)=>{
      const ms=p.year+"-"+pad(i+1);
      return `<button type="button" class="calcell month${ms===p.cur?" sel":""}" data-month="${ms}">${m}</button>`;
    }).join("")}</div>`);
}
function chooseMonthCell(ms){ const p=ui.picker; if(!p) return; setPicked(p.target,ms,monthShort(ms)); closePicker(); }

/* ---------------- events ---------------- */
function wire(){
  const v=document.getElementById("view");
  // The Add form re-renders whenever a chip is tapped, so what's typed is
  // kept in ui.draft and put back — otherwise picking a category after
  // typing the amount would silently clear it.
  const amt=v.querySelector("#amt");
  if(amt){
    amt.addEventListener("keydown",e=>{ if(e.key==="Enter") addTx(); });
    amt.addEventListener("input",e=>{ ui.draft.amt=e.target.value; });
  }
  const note=v.querySelector("#note"); if(note) note.addEventListener("input",e=>{ ui.draft.note=e.target.value; });
  const q=v.querySelector("#q");
  if(q) q.addEventListener("input",e=>{ ui.q=e.target.value; const p=e.target.selectionStart; render();
    const n=document.getElementById("q"); if(n){ n.focus(); n.setSelectionRange(p,p); } });
}
document.addEventListener("click",e=>{
  const el=e.target.closest("[data-tab],[data-ovrange],[data-type],[data-cat],[data-method],[data-fcat],[data-fwho],[data-tx],[data-act],[data-delcat],[data-addmoney],[data-editgoal],[data-editrec],[data-openledger],[data-remove],[data-uninvite],[data-restore],[data-purge],[data-unallow],[data-share],[data-pick],[data-pickdate],[data-pickmonth],[data-pickval],[data-day],[data-month],[data-calnav],[data-calnavyear],#openinv,#r-auto,#prevm,#nextm,#themebtn,#mebtn,#ledgersel");
  if(!el) return;
  if(el.id==="prevm"){ ui.month=shiftMonth(ui.month,-1); return render(); }
  if(el.id==="nextm"){ if(!el.disabled){ ui.month=shiftMonth(ui.month,1); render(); } return; }
  if(el.id==="themebtn") return cycleTheme();
  if(el.id==="mebtn"){ ui.tab="data"; return render(); }
  if(el.id==="ledgersel") return openLedgerSwitcher();
  if(el.id==="openinv") return toggleOpenInvites();
  if(el.id==="r-auto"){ el.setAttribute("aria-checked",el.getAttribute("aria-checked")==="true"?"false":"true"); return; }
  if(el.dataset.tab){ ui.tab=el.dataset.tab; return render(); }
  if(el.dataset.ovrange){ ui.ovRange=el.dataset.ovrange; return render(); }
  if(el.dataset.type){ ui.type=el.dataset.type; ui.cat=null; return render(); }
  if(el.dataset.cat){ ui.cat=el.dataset.cat; return render(); }
  if(el.dataset.method){ ui.method=el.dataset.method; return render(); }
  if(el.hasAttribute("data-fcat")){ ui.filterCat=el.dataset.fcat; return render(); }
  if(el.hasAttribute("data-fwho")){ ui.filterWho=el.dataset.fwho; return render(); }
  if(el.dataset.tx) return openTx(el.dataset.tx);
  if(el.dataset.addmoney) return openMoney(el.dataset.addmoney);
  if(el.dataset.editgoal) return openGoal(el.dataset.editgoal);
  if(el.dataset.editrec) return openRec(el.dataset.editrec);
  if(el.dataset.openledger){ closeSheet(); return openLedger(el.dataset.openledger); }
  if(el.dataset.remove) return removeMember(el.dataset.remove);
  if(el.dataset.restore) return restoreLedger(el.dataset.restore);
  if(el.dataset.purge) return purgeNow(el.dataset.purge);
  if(el.dataset.unallow) return unallow(el.dataset.unallow);
  if(el.dataset.share) return shareAllowed(el.dataset.share);
  if(el.dataset.uninvite) return withdrawInvite(el.dataset.uninvite);
  if(el.dataset.delcat) return delCat(el.dataset.delcat);
  if(el.hasAttribute("data-pick")) return openOptionPicker(el);
  if(el.hasAttribute("data-pickdate")) return openDatePicker(el);
  if(el.hasAttribute("data-pickmonth")) return openMonthPicker(el);
  if(el.dataset.pickval) return choosePickval(el);
  if(el.dataset.day) return chooseDay(el.dataset.day);
  if(el.dataset.month) return chooseMonthCell(el.dataset.month);
  if(el.dataset.calnav){ ui.picker.month=shiftMonth(ui.picker.month,parseInt(el.dataset.calnav,10)); return renderCalPicker(); }
  if(el.dataset.calnavyear){ ui.picker.year=Number(ui.picker.year)+parseInt(el.dataset.calnavyear,10); return renderMonthPicker(); }
  const acts={
    close:closeSheet, closepicker:closePicker, caltoday:pickToday, calclear:pickClear,
    addtx:addTx, savetx:saveTx, deltx:delTx,
    newgoal:()=>openGoal(null), savegoal:saveGoal, delgoal:delGoal, savemoney:saveMoney,
    newrec:()=>openRec(null), saverec:saveRec, delrec:delRec,
    savebudget:saveBudget, savecb:saveCatBudgets, addcat:addCat,
    invite:sendInvite, allow:allowEmail, copylink:copyLink, leave:leaveLedger, delledger:deleteLedger,
    newledger:newLedgerFromSheet, signout:()=>signOut(auth),
    exportcsv:exportCSV, exportjson:exportJSON,
    gotoenv:()=>{ui.tab="data";render();setTimeout(()=>{const n=document.getElementById("envelopes");if(n)n.scrollIntoView({behavior:"smooth",block:"start"})},60)}
  };
  if(acts[el.dataset.act]) return acts[el.dataset.act]();
});
document.addEventListener("keydown",e=>{
  if(e.key!=="Escape") return;
  if(document.querySelector("[data-picker-scrim]")) return closePicker();
  if(document.getElementById("scrim")) closeSheet();
});

/* ---------------- writes ---------------- */
const E=id=>doc(db,"ledgers",A.lid,"entries",id);
function addTx(){
  const a=parseAmt(val("amt"));
  if(!(a>0)) return toast("Enter an amount above zero");
  const date=val("date")||ymd(new Date());
  guard(async()=>{
    await setDoc(E(rid()),{
      amt:a,type:ui.type,cat:ui.cat,method:ui.method,note:val("note").trim(),date,
      uid:A.me.uid,by:A.me.displayName||"",u:now(),createdAt:serverTimestamp()});
    if(monthOf(date)!==ui.month) ui.month=monthOf(date);
    ui.draft={amt:"",note:"",date:date===ymd(new Date())?"":date};
    render();
    const n=document.getElementById("amt"); if(n) n.focus();
  },(ui.type==="income"?"Income ":"Expense ")+money2(a)+" added");
}
function saveTx(){
  const t=A.entries.find(x=>x.id===ui.editing); if(!t) return closeSheet();
  const a=parseAmt(val("e-amt"));
  if(!(a>0)) return toast("Enter an amount above zero");
  const body={amt:a,date:val("e-date")||t.date,cat:val("e-cat"),method:val("e-method"),note:val("e-note").trim(),u:now()};
  guard(async()=>{ await updateDoc(E(t.id),body); closeSheet(); },"Entry updated");
}
function delTx(){
  const id=ui.editing; if(!id) return;
  guard(async()=>{ await deleteDoc(E(id)); closeSheet(); },"Entry deleted");
}
function saveGoal(){
  const name=val("g-name").trim(), target=parseAmt(val("g-target")), saved=parseAmt(val("g-saved"))||0;
  if(!name) return toast("Give the goal a name");
  if(!(target>0)) return toast("Set a target above zero");
  const by=val("g-by")||"";
  guard(async()=>{
    if(ui.editing){
      await updateDoc(doc(db,"ledgers",A.lid,"goals",ui.editing),{name,target,saved,by,u:now()});
    }else{
      await setDoc(doc(db,"ledgers",A.lid,"goals",rid()),{name,target,saved,by,hist:[],uid:A.me.uid,by_name:A.me.displayName||"",u:now(),createdAt:serverTimestamp()});
    }
    closeSheet();
  },"Goal saved");
}
function delGoal(){
  const id=ui.editing; if(!id) return;
  guard(async()=>{ await deleteDoc(doc(db,"ledgers",A.lid,"goals",id)); closeSheet(); },"Goal deleted");
}
function saveMoney(){
  const g=A.goals.find(x=>x.id===ui.editing); if(!g) return closeSheet();
  const a=parseAmt(val("m-amt"));
  if(!(a>0)) return toast("Enter an amount above zero");
  const hist=(g.hist||[]).concat([{d:val("m-date")||ymd(new Date()),a,uid:A.me.uid}]);
  guard(async()=>{
    await updateDoc(doc(db,"ledgers",A.lid,"goals",g.id),{saved:(g.saved||0)+a,hist,u:now()});
    closeSheet();
  },money2(a)+" added to "+g.name);
}
function saveRec(){
  const name=val("r-name").trim(), amt=parseAmt(val("r-amt")), day=Math.min(31,Math.max(1,parseInt(val("r-day"),10)||1));
  if(!name) return toast("Give it a name");
  if(!(amt>0)) return toast("Set an amount above zero");
  const auto=document.getElementById("r-auto").getAttribute("aria-checked")==="true";
  const body={name,amt,day,kind:val("r-kind"),cat:val("r-cat"),method:val("r-method"),
    start:val("r-start")||monthOf(ymd(new Date())),count:parseInt(val("r-count"),10)||0,auto,u:now()};
  guard(async()=>{
    if(ui.editing) await updateDoc(doc(db,"ledgers",A.lid,"recur",ui.editing),body);
    else await setDoc(doc(db,"ledgers",A.lid,"recur",rid()),Object.assign({uid:A.me.uid,createdAt:serverTimestamp()},body));
    closeSheet();
  },"Saved — due instalments will post to the ledger");
}
function delRec(){
  const id=ui.editing; if(!id) return;
  guard(async()=>{ await deleteDoc(doc(db,"ledgers",A.lid,"recur",id)); closeSheet(); },"Recurring item removed");
}
function saveBudget(){
  const n=parseAmt(val("budget"));
  guard(async()=>{ await updateDoc(doc(db,"ledgers",A.lid),{"settings.budget":isFinite(n)&&n>0?n:0}); },"Budget saved");
}
function saveCatBudgets(){
  const o={};
  document.querySelectorAll("[data-cbudget]").forEach(i=>{ const n=parseAmt(i.value); if(isFinite(n)&&n>0) o[i.dataset.cbudget]=n; });
  guard(async()=>{ await updateDoc(doc(db,"ledgers",A.lid),{"settings.catBudgets":o}); },"Category budgets saved");
}
function addCat(){
  const name=val("newcat").trim(); if(!name) return;
  const st=settings();
  if(st.cats.includes(name)) return toast("That category already exists");
  guard(async()=>{ await updateDoc(doc(db,"ledgers",A.lid),{"settings.cats":st.cats.concat([name])}); },"Category added");
}
function delCat(name){
  if(A.entries.some(t=>t.cat===name)) return toast("Entries still use "+name+" — reassign them first");
  const st=settings(), cb=Object.assign({},st.catBudgets); delete cb[name];
  guard(async()=>{ await updateDoc(doc(db,"ledgers",A.lid),{"settings.cats":st.cats.filter(c=>c!==name),"settings.catBudgets":cb}); });
}

/* ---------------- people ---------------- */
function sendInvite(){
  const email=val("i-email").trim().toLowerCase(), role=val("i-role");
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Enter a valid email address");
  if(A.members.some(m=>(m.email||"")===email)) return toast("They're already in this ledger");
  guard(async()=>{
    // Inviting someone into a ledger also enrols them in the app; without
    // this they'd claim the invite and then be unable to do anything.
    if(A.seed||A.openInvites){
      await setDoc(doc(db,"allowed",email),{email,by:A.me.uid,at:serverTimestamp()},{merge:true});
    }
    await setDoc(doc(db,"ledgers",A.lid,"invites",email),{email,role,invitedBy:A.me.uid,createdAt:serverTimestamp()});
    document.getElementById("i-email").value="";
    if(A.seed) await loadAllowList();
    render();
  },A.seed||A.openInvites?"Invite created — send them the link below"
    :"Invite created, but new people are switched off — ask the app owner to enrol this address");
}
function allowEmail(){
  const email=val("a-email").trim().toLowerCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast("Enter a valid email address");
  if(A.allowList.some(a=>a.email===email)) return toast("They're already on the list");
  guard(async()=>{
    await setDoc(doc(db,"allowed",email),{email,by:A.me.uid,at:serverTimestamp()},{merge:true});
    await loadAllowList(); render();
  },email+" can now use the app");
}
// navigator.share opens the OS share sheet (WhatsApp/Messages on a phone)
// so inviting someone is one tap, not "go copy this link and paste it
// somewhere yourself"; desktop browsers without it fall back to a
// prefilled mailto: instead.
function shareAllowed(email){
  const url=location.origin+location.pathname;
  const text=`You're invited to use Paisa Ledger — sign in with your Google account (${email}) to get started.`;
  if(navigator.share){ navigator.share({title:"Paisa Ledger",text,url}).catch(()=>{}); }
  else location.href=`mailto:${email}?subject=${encodeURIComponent("You're invited to Paisa Ledger")}&body=${encodeURIComponent(text+"\n\n"+url)}`;
}
function unallow(email){
  if(!confirm("Remove "+email+" from the app?\n\nThey keep access to ledgers they're already in — remove them there separately — but they can't start new ones.")) return;
  guard(async()=>{
    await deleteDoc(doc(db,"allowed",email));
    await loadAllowList(); render();
  },"Removed from the app");
}
function toggleOpenInvites(){
  const next=!A.openInvites;
  guard(async()=>{
    await setDoc(doc(db,"config","app"),{openInvites:next},{merge:true});
    A.openInvites=next; render();
  },next?"Ledger owners can invite new people":"Only you can enrol new people now");
}
function withdrawInvite(email){
  guard(async()=>{ await deleteDoc(doc(db,"ledgers",A.lid,"invites",email)); },"Invite withdrawn");
}
function changeRole(uid,role){
  guard(async()=>{ await updateDoc(doc(db,"ledgers",A.lid,"members",uid),{role}); },"Access updated");
}
function removeMember(uid){
  if(!confirm("Remove "+memberName(uid)+" from this ledger? Entries they added stay.")) return;
  guard(async()=>{ await deleteDoc(doc(db,"ledgers",A.lid,"members",uid)); },"Removed");
}
function leaveLedger(){
  if(!confirm("Leave this ledger? You'll need a fresh invite to get back in.")) return;
  guard(async()=>{
    await deleteDoc(doc(db,"ledgers",A.lid,"members",A.me.uid));
    localStorage.removeItem("paisa.lid");
    await loadLedgers();
  },"You've left the ledger");
}
/* ---------------- deleting a ledger ----------------
   Deleting hides the ledger from everyone immediately, but keeps it for
   GRACE_DAYS so a mistaken tap can be undone. Once the grace period lapses
   the app purges it for real — entries first, the ledger record last —
   the next time its owner opens the app. No server, no scheduled job:
   the owner is the only one who can purge it, and the only one who sees
   it waiting. */
const daysSince=d=>Math.floor((new Date(ymd(new Date()))-new Date(d))/864e5);
const daysLeft=l=>Math.max(0,GRACE_DAYS-daysSince(l.deletedAt));

async function deleteLedger(){
  const name=A.ledger.name;
  if(!confirm(`Delete "${name}"?\n\nIt disappears for everyone straight away, but you can restore it from Data → Recently deleted for the next ${GRACE_DAYS} days. After that it's cleared for good.`)) return;
  await guard(async()=>{
    await updateDoc(doc(db,"ledgers",A.lid),{deletedAt:ymd(new Date()),deletedBy:A.me.uid});
    localStorage.removeItem("paisa.lid");
    await loadLedgers();
  },`"${name}" deleted — restorable for ${GRACE_DAYS} days`);
}
async function restoreLedger(lid){
  const l=A.deleted.find(x=>x.id===lid); if(!l) return;
  await guard(async()=>{
    await updateDoc(doc(db,"ledgers",lid),{deletedAt:deleteField(),deletedBy:deleteField()});
    await loadLedgers();
    await openLedger(lid);
  },`"${l.name}" is back`);
}
async function purgeNow(lid){
  const l=A.deleted.find(x=>x.id===lid); if(!l) return;
  if(!confirm(`Permanently clear "${l.name}"?\n\nEvery entry, goal and EMI inside it is deleted from the database. This cannot be undone — export first if you want a copy.`)) return;
  await guard(async()=>{ const n=await purgeLedger(lid); await loadLedgers(); render();
    toast(`"${l.name}" cleared — ${n} records removed`); });
}
// Firestore does not cascade: every document under the ledger has to be
// deleted by name, and the ledger record itself goes last so the rules can
// still resolve its owner while the rest is being cleared.
async function purgeLedger(lid){
  const L=doc(db,"ledgers",lid);
  let n=0;
  const wipe=async items=>{
    for(let i=0;i<items.length;i+=100){
      await Promise.all(items.slice(i,i+100).map(r=>deleteDoc(r)));
      n+=Math.min(100,items.length-i);
    }
  };
  for(const c of ["entries","goals","recur","invites"]){
    const s=await getDocs(collection(L,c));
    await wipe(s.docs.map(d=>doc(db,"ledgers",lid,c,d.id)));
  }
  const ms=await getDocs(collection(L,"members"));
  // Other members first; the owner's own membership is the last thing to go
  // before the ledger record, since removing it early would strand the purge.
  await wipe(ms.docs.filter(d=>d.id!==A.me.uid).map(d=>doc(db,"ledgers",lid,"members",d.id)));
  await wipe(ms.docs.filter(d=>d.id===A.me.uid).map(d=>doc(db,"ledgers",lid,"members",d.id)));
  await deleteDoc(L); n++;
  return n;
}
async function purgeExpired(){
  const due=A.deleted.filter(l=>daysLeft(l)<=0);
  if(!due.length) return;
  let total=0;
  for(const l of due){
    try{ total+=await purgeLedger(l.id); }
    catch(e){ console.warn("purge",l.id,e); }
  }
  A.deleted=A.deleted.filter(l=>daysLeft(l)>0);
  if(total){ toast(`Cleared ${due.length} ledger${due.length>1?"s":""} past the ${GRACE_DAYS}-day window`); render(); }
}
function newLedgerFromSheet(){
  const name=val("nl-name").trim();
  if(!name) return toast("Give the ledger a name");
  guard(async()=>{ closeSheet(); await createLedger(name); });
}
async function copyLink(){
  const link=location.origin+location.pathname+"#join="+A.lid;
  try{ await navigator.clipboard.writeText(link); toast("Invite link copied"); }
  catch(e){ const n=document.getElementById("joinlink"); if(n){ n.select(); } toast("Select and copy the link above"); }
}

/* ---------------- export ---------------- */
function download(filename,text){
  const url=URL.createObjectURL(new Blob([text],{type:"text/plain;charset=utf-8"}));
  const a=document.createElement("a"); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),4000);
}
function exportCSV(){
  const rows=[["date","type","category","amount","method","note","added_by","auto"]];
  A.entries.slice().sort((a,b)=>a.date<b.date?-1:1).forEach(t=>
    rows.push([t.date,t.type,t.cat,t.amt,t.method||"",t.note||"",memberName(t.uid),t.rec?"yes":""]));
  const csv=rows.map(r=>r.map(c=>{const s=String(c);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}).join(",")).join("\n");
  download("paisa-"+(A.ledger.name||"ledger").replace(/\W+/g,"-").toLowerCase()+"-"+ymd(new Date())+".csv",csv);
}
function exportJSON(){
  download("paisa-"+(A.ledger.name||"ledger").replace(/\W+/g,"-").toLowerCase()+"-"+ymd(new Date())+".json",
    JSON.stringify({ledger:{name:A.ledger.name,settings:settings()},members:A.members.map(m=>({name:m.name,email:m.email,role:m.role})),
      entries:A.entries,goals:A.goals,recur:A.recur},null,1));
}

/* ---------------- theme + connectivity ---------------- */
function cycleTheme(){
  const r=document.documentElement, cur=r.getAttribute("data-theme");
  const next=cur==="dark"?"light":cur==="light"?null:"dark";
  if(next) r.setAttribute("data-theme",next); else r.removeAttribute("data-theme");
  try{ next?localStorage.setItem("paisa.theme",next):localStorage.removeItem("paisa.theme"); }catch(e){}
}
try{ const th=localStorage.getItem("paisa.theme"); if(th) document.documentElement.setAttribute("data-theme",th); }catch(e){}
function paintNet(){
  const d=document.getElementById("netdot"), t=document.getElementById("nettext");
  if(!d) return;
  const on=navigator.onLine;
  d.className="netdot"+(on?"":" off");
  t.textContent=on?"Online":"Offline";
  d.title=on?"Changes sync as you make them":"Working from this device — changes upload when you're back online";
}
window.addEventListener("online",paintNet);
window.addEventListener("offline",paintNet);
paintNet();

if("serviceWorker" in navigator){
  window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
}
