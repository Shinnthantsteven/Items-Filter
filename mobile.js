(function(){
var mq=matchMedia('(max-width:700px)');
function mob(){return mq.matches;}

var css=`
#qkb{position:fixed;left:0;right:0;bottom:0;z-index:5000;display:none;flex-direction:column;gap:6px;padding:8px 4px max(8px,env(safe-area-inset-bottom));
background:color-mix(in srgb,var(--card-bg) 88%,transparent);backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);border-top:1px solid var(--glass-edge)}
#qkb.open{display:flex}
.kr{display:flex;justify-content:center;gap:5px}
.kk{flex:1;max-width:38px;height:42px;border:none;border-radius:8px;background:rgba(255,255,255,.1);color:var(--text);font:600 18px 'Plus Jakarta Sans',sans-serif;display:flex;align-items:center;justify-content:center;touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none}
[data-theme="light"] .kk{background:rgba(0,0,0,.07)}
.kk:active{transform:scale(.94);background:rgba(16,185,129,.35)}
.kk.sp{flex:5;max-width:none;font-size:13px}
.kk.bk{flex:0 0 52px;max-width:52px;color:var(--danger)}
.kb-bar{display:flex;gap:8px;align-items:center;padding:0 4px}
#kbDisp{flex:1;min-height:38px;display:flex;align-items:center;padding:0 12px;border-radius:10px;background:var(--input-bg);border:1px solid var(--glass-edge);font-weight:700;font-size:15px;overflow:hidden;white-space:pre}
#kbDisp.empty{color:#64748b;font-weight:500}
#kbDisp i{display:inline-block;width:2px;height:1.1em;background:var(--brand);margin-left:1px;animation:kbb 1s step-end infinite}
@keyframes kbb{50%{opacity:0}}
.kb-btn{height:38px;border:none;border-radius:10px;padding:0 14px;font:800 14px 'Plus Jakarta Sans',sans-serif;touch-action:manipulation}
.chip{display:inline-flex;align-items:center;gap:5px;min-height:44px;padding:0 10px;border:1px solid var(--glass-edge);border-radius:22px;background:var(--input-bg);color:var(--text);font:800 12px monospace;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none}
.chip.ok{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.5);color:var(--brand)}
@media(max-width:700px){
html,body{position:fixed;inset:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;touch-action:manipulation}
body{display:flex;flex-direction:column}
.top-nav{flex-shrink:0;background:var(--bg-color);padding:calc(10px + env(safe-area-inset-top,0px)) calc(14px + env(safe-area-inset-right,0px)) 10px calc(14px + env(safe-area-inset-left,0px))}.logo-text{font-size:16px;gap:10px}.logo-wrap{width:34px;height:34px}
.top-nav>div:last-child>div{display:none}
.content-container{flex:1 1 0;min-height:0;height:auto;padding:0 0 130px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
mask-image:linear-gradient(to bottom,#000 calc(100% - 150px),rgba(0,0,0,.45) calc(100% - 88px),rgba(0,0,0,.2) 100%);
-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 150px),rgba(0,0,0,.45) calc(100% - 88px),rgba(0,0,0,.2) 100%)}
body.kb .content-container{mask-image:none;-webkit-mask-image:none}
table,tbody,tr{display:block;width:100%}
thead{display:block;position:sticky;top:0;z-index:50;background:#0d1829;border-bottom:1px solid var(--glass-edge)}
[data-theme="light"] thead{background:#334155}
thead tr{display:grid;grid-template-columns:minmax(0,1fr) 64px;padding:0 14px}
thead tr th{position:static;display:none;padding:8px 0;border:none!important;border-radius:0!important;width:auto!important;font-size:8px}
thead tr th:nth-child(2),thead tr th:nth-child(3){display:block}
thead tr th:nth-child(3){text-align:center}
td.m-card{display:grid;grid-template-columns:minmax(0,1fr) auto 64px;column-gap:10px;row-gap:4px;align-content:center;min-height:calc((100dvh - 150px)/7);padding:10px 14px;border-bottom:1px solid var(--glass-edge);cursor:default;white-space:normal;overflow:visible}
.m-name{grid-area:1/1;align-self:center;font-weight:700;font-size:14px;line-height:1.35}
.m-pack{color:#818cf8;font-size:11px;font-weight:700;margin-left:5px;white-space:nowrap}
.m-code{grid-area:1/2;align-self:center}
.m-price{grid-area:1/3;align-self:center;text-align:center;color:var(--brand);font-weight:800;font-size:20px;line-height:1.1}
.m-sup{grid-area:2/1/3/3;font-size:11px;color:#94a3b8;font-weight:600;line-height:1.35}
.m-mpn{grid-area:4/1/5/3;font-family:monospace;font-size:10px;color:#64748b}
.m-cur{grid-area:2/3;text-align:center;font-size:10px;font-weight:800;color:#94a3b8}
.m-pills{grid-area:3/1/4/3;display:flex;flex-wrap:wrap;gap:4px}
.m-pills span{font-size:8px;padding:2px 7px}
.m-um{grid-area:3/3;justify-self:center;align-self:start;font-size:9px;font-weight:900;padding:2px 7px;border-radius:20px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.28);color:var(--brand)}
.m-sup:empty,.m-cur:empty,.m-pills:empty,.m-um:empty{display:none}
.portal-bar{width:calc(100% - 24px);max-width:560px;bottom:max(12px,env(safe-area-inset-bottom));overflow:hidden;
background:linear-gradient(135deg,rgba(255,255,255,.20),rgba(255,255,255,.05) 45%,rgba(255,255,255,.12));
backdrop-filter:blur(16px) saturate(190%) brightness(1.12);-webkit-backdrop-filter:blur(16px) saturate(190%) brightness(1.12);
border:1px solid rgba(255,255,255,.34);
box-shadow:inset 0 1.5px 1px rgba(255,255,255,.75),inset 0 -1px 1px rgba(255,255,255,.22),inset 0 0 20px rgba(255,255,255,.10),0 12px 32px rgba(0,0,0,.35),0 2px 6px rgba(0,0,0,.22)}
.portal-bar::before{top:0;left:14%;right:14%;height:1.5px}
.portal-bar::after{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:1;background:radial-gradient(130% 150% at 12% -30%,rgba(255,255,255,.34),transparent 50%),radial-gradient(90% 120% at 95% 130%,rgba(255,255,255,.14),transparent 55%)}
[data-theme="light"] .portal-bar{background:linear-gradient(135deg,rgba(255,255,255,.55),rgba(255,255,255,.22) 45%,rgba(255,255,255,.4));border-color:rgba(255,255,255,.85);box-shadow:inset 0 1.5px 1px rgba(255,255,255,.95),inset 0 -1px 1px rgba(255,255,255,.5),0 10px 28px rgba(15,23,42,.18),0 2px 6px rgba(15,23,42,.1)}
.bar-upload-btn{width:44px;height:50px;flex-shrink:0}
.bar-search-wrap{flex:1 1 0;min-width:0;padding:0 8px 0 12px;gap:8px;position:relative;z-index:2}
#searchIn{min-width:0;width:100%;padding:15px 0;font-size:14px}
.bar-count{padding:3px 9px;font-size:10px}
.bar-exit-btn{flex:0 0 auto;height:50px;padding:0 16px;font-size:12px;position:relative;z-index:2;border-radius:0}
#searchIn{pointer-events:none}
#aiBadge{display:none!important}#toast{bottom:84px}
body.kb .portal-bar{display:none}
.login-card,.upload-card{width:calc(100% - 32px);padding:32px 22px}
}`;
var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

var origBuild=buildRow;
buildRow=function(r){return mob()?mrow(r):origBuild(r);};
function mrow(r){
  var c=String(r.id||'').replace(/"/g,'&quot;');
  return '<td class="m-card" colspan="8"><div class="m-name">'+highlight(r.desc)+(r.pack?'<span class="m-pack">'+highlight(r.pack)+'</span>':'')+'</div>'
  +'<div class="m-code"><button type="button" class="chip" data-code="'+c+'"><span>📋</span><span>'+highlight(r.id)+'</span></button></div>'
  +'<div class="m-price">'+highlight(r.cost)+'</div>'
  +'<div class="m-sup">'+(r.sup?'('+highlight(r.sup)+')':'')+'</div>'
  +(r.manu?'<div class="m-mpn">MPN '+highlight(r.manu)+'</div>':'')
  +'<div class="m-cur">'+(r.cost?'AED':'')+'</div>'
  +'<div class="m-pills">'+(r.brand?'<span class="brand-pill">'+highlight(r.brand)+'</span>':'')+(r.cat?'<span class="cat-pill">'+highlight(r.cat)+'</span>':'')+(r.state?'<span class="state-pill">'+highlight(r.state)+'</span>':'')+'</div>'
  +'<div class="m-um">'+highlight(r.um)+'</div></td>';
}

var origProcess=processData;
processData=function(data,isCSV){
  origProcess(data,isCSV);
  try{
    var wb=isCSV?XLSX.read(data,{type:'string'}):XLSX.read(new Uint8Array(data),{type:'array'});
    var raw=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
    var mk=Object.keys(raw[0]||{}).find(function(k){return k.toLowerCase().indexOf('manu')>-1;});
    if(!mk)return;
    raw.forEach(function(r,i){var v=clean(r[mk]);if(v&&db[i])db[i].manu=v;});
    filteredDb=db;renderPage(true);
  }catch(e){console.error(e);}
};

var origCopy=handleQuickCopy;
handleQuickCopy=function(e){
  if(!mob())return origCopy(e);
  var b=e.target.closest('.chip');if(b)copy(b);
};
function copy(b){
  if(b.dataset.busy)return;
  var code=b.dataset.code;
  function done(){
    b.dataset.busy=1;var o=b.innerHTML;b.classList.add('ok');b.innerHTML='<span>✓</span><span>Copied</span>';
    if(navigator.vibrate)navigator.vibrate(40);
    setTimeout(function(){b.classList.remove('ok');b.innerHTML=o;delete b.dataset.busy;},1200);
  }
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(code).then(done,function(){fb(code,done);});
  else fb(code,done);
}
function fb(t,d){
  var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;opacity:0';
  document.body.appendChild(a);a.select();
  try{document.execCommand('copy');d();}catch(x){}
  document.body.removeChild(a);
}

var kb=document.createElement('div');kb.id='qkb';
var rows=['1234567890','qwertyuiop','asdfghjkl','zxcvbnm'];
var h=rows.map(function(r,i){
  return '<div class="kr">'+r.split('').map(function(c){return '<button type="button" class="kk" data-k="'+c+'">'+c+'</button>';}).join('')
  +(i==3?'<button type="button" class="kk bk" data-k="bk">⌫</button>':'')+'</div>';
}).join('');
h+='<div class="kr"><button type="button" class="kk sp" data-k=" ">space</button></div>'
 +'<div class="kb-bar"><div id="kbDisp" class="empty">Search…</div>'
 +'<button type="button" class="kb-btn" id="kbClr" style="background:rgba(239,68,68,.15);color:#ef4444">✕</button>'
 +'<button type="button" class="kb-btn" id="kbDone" style="background:var(--brand);color:#020617">Done</button></div>';
kb.innerHTML=h;document.body.appendChild(kb);

var q='',bt=null,bi=null,disp=document.getElementById('kbDisp'),si=document.getElementById('searchIn');
function draw(){
  disp.textContent=q||'Search…';disp.className=q?'':'empty';
  if(q)disp.appendChild(document.createElement('i'));
}
function apply(){si.value=q;si.dispatchEvent(new Event('input'));draw();}
function press(k){
  if(k==='bk')q=q.slice(0,-1);else q+=k;
  if(navigator.vibrate)navigator.vibrate(5);
  apply();
}
function stop(){clearTimeout(bt);clearInterval(bi);}
kb.addEventListener('pointerdown',function(e){
  var b=e.target.closest('[data-k]');if(!b)return;
  e.preventDefault();press(b.dataset.k);
  if(b.dataset.k==='bk')bt=setTimeout(function(){bi=setInterval(function(){press('bk');},60);},350);
});
kb.addEventListener('pointerup',stop);kb.addEventListener('pointercancel',stop);kb.addEventListener('pointerleave',stop);
document.getElementById('kbClr').addEventListener('pointerdown',function(e){e.preventDefault();q='';apply();});
document.getElementById('kbDone').addEventListener('pointerdown',function(e){e.preventDefault();closeKb();});

function layout(){
  var c=document.querySelector('.content-container');
  if(!kb.classList.contains('open')){c.style.height='';c.style.flex='';c.style.paddingBottom='';return;}
  var top=c.getBoundingClientRect().top,vh=(window.visualViewport&&visualViewport.height)||innerHeight;
  c.style.flex='none';c.style.height=Math.max(120,vh-top-kb.offsetHeight)+'px';c.style.paddingBottom='20px';
}
function openKb(){if(!mob())return;q=si.value;kb.classList.add('open');document.body.classList.add('kb');draw();requestAnimationFrame(layout);}
function closeKb(){kb.classList.remove('open');document.body.classList.remove('kb');layout();}
document.querySelector('.bar-search-wrap').addEventListener('click',openKb);

function sync(){
  if(mob()){si.setAttribute('readonly','');si.setAttribute('inputmode','none');}
  else{si.removeAttribute('readonly');si.removeAttribute('inputmode');closeKb();}
}
mq.addEventListener('change',function(){sync();if(db.length)renderPage(true);});
sync();

document.addEventListener('touchmove',function(e){
  if(!mob())return;
  if(e.target.closest&&e.target.closest('.content-container,#sideMenu,.upload-card'))return;
  e.preventDefault();
},{passive:false});

var ADM=['shinnthantsteven@gmail.com','steve@example.com'];
sb.auth.onAuthStateChange(function(ev,s){
  if(!s)return;
  var ok=ADM.indexOf((s.user.email||'').toLowerCase())>-1;
  document.querySelectorAll('[onclick^="showUploadScreen"],[onclick^="pushToCloud"],.bar-upload-btn').forEach(function(x){x.style.display=ok?'':'none';});
});
})();
