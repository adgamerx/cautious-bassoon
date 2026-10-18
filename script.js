const LANGS=[
 {n:'English',sp:'en-US',tl:'en'},{n:'Hindi',sp:'hi-IN',tl:'hi'},{n:'Spanish',sp:'es-ES',tl:'es'},
 {n:'Tamil',sp:'ta-IN',tl:'ta'},{n:'Bengali',sp:'bn-IN',tl:'bn'},{n:'French',sp:'fr-FR',tl:'fr'},
 {n:'German',sp:'de-DE',tl:'de'},{n:'Japanese',sp:'ja-JP',tl:'ja'},{n:'Arabic',sp:'ar-SA',tl:'ar'},
 {n:'Portuguese',sp:'pt-BR',tl:'pt'},{n:'Russian',sp:'ru-RU',tl:'ru'},{n:'Chinese',sp:'zh-CN',tl:'zh-CN'}];
const $=s=>document.querySelector(s);
const byTl=t=>LANGS.find(l=>l.tl===t)||LANGS[0];
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fill=(sel,tl)=>{sel.innerHTML=LANGS.map(l=>`<option value="${l.tl}">${l.n}</option>`).join('');sel.value=tl;};

let msgs={},order=[],views=[],conn=null,peer=null,micOn=false,rec=null,speakOn=true,isNet=false,timers=[];
const heat={A:0,B:0};

/* ---------- translation ---------- */
async function translate(text,from,to){
  if(!text.trim()||from===to)return text;
  try{
    const r=await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`);
    const j=await r.json();
    return j[0].filter(Boolean).map(x=>x[0]).join('');
  }catch(e){
    try{
      const r=await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`);
      const j=await r.json();return j.responseData.translatedText;
    }catch(e2){return '(translation unavailable)';}
  }
}

/* ---------- heat: exclamations, shouting, long rants ---------- */
const score=t=>(t.match(/[!?]/g)||[]).length*2+(t.match(/\b[A-Z\u00C1\u00C9\u00CD\u00D3\u00DA\u00D1]{3,}\b/g)||[]).length*2+t.length/60;
const bump=(k,d)=>{heat[k]=Math.min(100,Math.max(0,heat[k]+d*6));};
function paintHeat(){$('#hA').style.width=heat.A/2+'%';$('#hB').style.width=heat.B/2+'%';}
setInterval(()=>{heat.A*=.96;heat.B*=.96;paintHeat();},200);

/* ---------- core: every utterance, live or final, goes through here ---------- */
function handle(from,id,lang,text,final){
  let m=msgs[id];
  if(!m){
    m=msgs[id]={id,from,lang,text:'',final:false,tr:{}};order.push(id);
    // interruption: someone starts while the other side is still mid-sentence
    const other=order.map(i=>msgs[i]).reverse().find(x=>x.from!==from&&!x.final);
    if(other){other.talkedOver=true;bump('A',2);bump('B',2);}
    if(window.speechSynthesis)speechSynthesis.cancel(); // barge-in: stop reading the old translation
  }
  if(m.text.length>6&&!text.startsWith(m.text.slice(0,m.text.length-8)))m.revised=m.text; // took something back
  bump(from,score(text)-score(m.text));
  m.text=text;m.final=final;
  views.forEach(v=>{if(v.key!==from)queueTranslate(m,v);});
  renderAll();
}
function queueTranslate(m,v){
  clearTimeout(m['t'+v.key]);
  m['t'+v.key]=setTimeout(async()=>{
    const snap=m.text;
    const out=await translate(snap,m.lang,v.tl);
    if(m.text!==snap)return; // newer text already queued
    m.tr[v.key]=out;render(v);
    if(m.final&&isNet&&speakOn)speak(out,v);
  },m.final?0:260);
}
function speak(t,v){
  if(!window.speechSynthesis)return;
  const u=new SpeechSynthesisUtterance(t);u.lang=byTl(v.tl).sp;
  const h=Math.max(heat.A,heat.B);u.rate=1+h/200;u.pitch=1+h/300; // angrier = faster, higher
  speechSynthesis.speak(u);
}

/* ---------- rendering ---------- */
function render(v){
  v.log.innerHTML=order.map(id=>{
    const m=msgs[id],own=m.from===v.key,L=byTl(m.lang).n;
    const main=own?m.text:(m.tr[v.key]??'...');
    const sub=own?(m.revised?`<s>${esc(m.revised)}</s>`:''):`${esc(L)}: ${esc(m.text)}`;
    const fresh=!v.seen.has(id);v.seen.add(id);
    return `<div class="msg ${own?'own':'their'} ${m.final?'':'live'} ${m.talkedOver?'over':''} ${fresh?'enter':''}">
      <div class="main">${esc(main)}</div>${sub?`<div class="sub">${sub}</div>`:''}
      ${m.talkedOver?'<div class="tag">talked over</div>':''}</div>`;
  }).join('');
  v.log.scrollTop=v.log.scrollHeight;
}
const renderAll=()=>views.forEach(render);

/* ---------- panels ---------- */
function send(v,rawId,text,final){
  handle(v.key,v.key+'-'+rawId,v.tl,text,final);
  if(conn&&conn.open)conn.send({t:'msg',id:rawId,lang:v.tl,text,final});
}
function buildViews(list){
  const box=$('#panels');box.innerHTML='';box.className=list.length>1?'two':'';
  views=list.map(o=>{
    const el=document.createElement('div');el.className='panel '+o.key;
    el.innerHTML=`<div class="phead"><b>${o.label}</b><select aria-label="Language"></select></div>
      <div class="log" aria-live="polite"></div>
      <input class="say" placeholder="Type here. It sends as you type." autocomplete="off">`;
    box.append(el);
    const v={key:o.key,tl:o.tl,log:el.querySelector('.log'),sel:el.querySelector('select'),inp:el.querySelector('.say'),cur:null,seen:new Set()};
    fill(v.sel,v.tl);
    v.sel.onchange=()=>{v.tl=v.sel.value;if(rec){stopMic();startMic();}renderAll();};
    v.inp.oninput=()=>{
      if(!v.inp.value.trim())return;
      if(!v.cur)v.cur=Date.now()+'-'+Math.random().toString(36).slice(2,5);
      send(v,v.cur,v.inp.value,false);
    };
    v.inp.onkeydown=e=>{
      if(e.key==='Enter'&&v.cur&&v.inp.value.trim()){send(v,v.cur,v.inp.value,true);v.cur=null;v.inp.value='';}
    };
    return v;
  });
}

/* ---------- mic: always on, interim results stream out ---------- */
function startMic(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){$('#status').textContent='Mic needs Chrome or Edge. Typing still works.';return;}
  const v=views[0];let base=Date.now();
  rec=new SR();rec.continuous=true;rec.interimResults=true;rec.lang=byTl(v.tl).sp;
  rec.onresult=e=>{
    for(let i=e.resultIndex;i<e.results.length;i++){
      const r=e.results[i];send(v,base+'-'+i,r[0].transcript,r.isFinal);
    }
  };
  rec.onend=()=>{if(micOn){base=Date.now();try{rec.start();}catch(e){}}};
  rec.onerror=e=>{$('#status').textContent='Mic: '+e.error;};
  try{rec.start();}catch(e){}
}
function stopMic(){const r=rec;rec=null;if(r){r.onend=null;try{r.stop();}catch(e){}}}
$('#mic').onclick=()=>{
  micOn=!micOn;$('#mic').textContent=micOn?'Stop mic':'Start mic';
  micOn?startMic():stopMic();
};
$('#speak').onchange=e=>{speakOn=e.target.checked;if(!speakOn&&window.speechSynthesis)speechSynthesis.cancel();};

/* ---------- WebRTC via PeerJS: text goes straight between the two browsers ---------- */
function wire(c){
  conn=c;
  c.on('open',()=>{$('#status').textContent='Connected. Start talking.';});
  c.on('data',d=>{if(d&&d.t==='msg')handle('B','B-'+d.id,d.lang,d.text,d.final);});
  c.on('close',()=>{$('#status').textContent='The other person left.';});
}
function startRoom(){
  const code='talk-'+Math.random().toString(36).slice(2,7);
  peer=new Peer(code);
  peer.on('open',()=>{
    const url=location.origin+location.pathname+'?room='+code;
    $('#link').textContent=url;$('#linkrow').hidden=false;
    $('#status').textContent='Waiting for the other person to open the link...';
  });
  peer.on('connection',wire);
  peer.on('error',e=>{$('#status').textContent='Connection error: '+e.type;});
}
function joinRoom(code){
  peer=new Peer();
  peer.on('open',()=>wire(peer.connect(code,{reliable:true})));
  peer.on('error',e=>{$('#status').textContent='Connection error: '+e.type;});
}
$('#copy').onclick=()=>{navigator.clipboard.writeText($('#link').textContent);$('#copy').textContent='Copied';};

/* ---------- solo demo ---------- */
function typeOut(v,text,cut){
  const id='s'+Math.random().toString(36).slice(2,6),end=cut||text.length;let i=0;
  const iv=setInterval(()=>{i++;send(v,id,text.slice(0,i),i>=end);if(i>=end)clearInterval(iv);},45);
  timers.push(iv);
}
function clearAll(){
  timers.forEach(t=>{clearTimeout(t);clearInterval(t);});timers=[];
  msgs={};order=[];heat.A=heat.B=0;views.forEach(v=>v.seen.clear());renderAll();
}
$('#sample').onclick=()=>{
  clearAll();
  const [A,B]=views;A.tl='hi';A.sel.value='hi';B.tl='es';B.sel.value='es';
  const S=[
    [A,0,'\u0924\u0941\u092E\u0928\u0947 \u092B\u093F\u0930 \u0938\u0947 \u092E\u0947\u0930\u0940 \u092C\u093E\u0924 \u0928\u0939\u0940\u0902 \u0938\u0941\u0928\u0940! \u092E\u0948\u0902\u0928\u0947 \u0915\u0939\u093E \u0925\u093E \u0915\u093F \u0939\u092E \u0936\u0928\u093F\u0935\u093E\u0930 \u0915\u094B',36],
    [B,1700,'\u00A1No, espera! \u00A1Nunca me avisas a tiempo!'],
    [A,3900,'\u092E\u0948\u0902\u0928\u0947 \u0924\u0940\u0928 \u092C\u093E\u0930 \u092C\u0924\u093E\u092F\u093E \u0925\u093E, \u0924\u0941\u092E \u092B\u094B\u0928 \u092E\u0947\u0902 \u0932\u0917\u0947 \u0925\u0947!'],
    [B,5400,'\u00A1Eso es mentira! ...no, espera, quiz\u00E1 s\u00ED lo dijiste una vez.'],
    [A,9800,'\u0924\u094B \u0905\u092C \u092E\u093E\u0928 \u0930\u0939\u0947 \u0939\u094B?!'],
    [B,11200,'Vale, vale. Tienes raz\u00F3n. Lo siento.'],
    [A,13400,'\u0920\u0940\u0915 \u0939\u0948\u0964 \u0936\u0928\u093F\u0935\u093E\u0930 \u092A\u0915\u094D\u0915\u093E\u0964']
  ];
  S.forEach(([v,t0,text,cut])=>timers.push(setTimeout(()=>typeOut(v,text,cut),t0)));
};
$('#clear').onclick=clearAll;

/* ---------- start-up ---------- */
const room=new URLSearchParams(location.search).get('room');
fill($('#myLang'),'en');
if(room){$('#join').hidden=false;$('#startBtns').hidden=true;}
function enter(mode){
  $('#home').hidden=true;$('#app').hidden=false;
  if(mode==='net'){
    isNet=true;speakOn=true;
    buildViews([{key:'A',tl:$('#myLang').value,label:'You'}]);
    $('#netbar').hidden=false;
  }else{
    isNet=false;speakOn=false;
    buildViews([{key:'A',tl:'hi',label:'Person A'},{key:'B',tl:'es',label:'Person B'}]);
    $('#solobar').hidden=false;
  }
}
$('#startRoom').onclick=()=>{enter('net');startRoom();};
$('#joinBtn').onclick=()=>{enter('net');joinRoom(room);};
$('#solo').onclick=()=>enter('solo');
