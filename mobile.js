/* Phone layout for the item list.
   - uses the phone's REAL keyboard (typing, paste, voice, Arabic, symbols all work)
   - search bar is docked at the bottom and always sits right above the keyboard
   - items show as cards instead of a wide table */
(function(){
var mq=matchMedia('(max-width:700px)');
function mob(){return mq.matches;}

var css=`
.chip{display:inline-flex;align-items:center;gap:5px;min-height:44px;padding:0 10px;border:1px solid var(--glass-edge);border-radius:22px;background:var(--input-bg);color:var(--text);font:800 12px monospace;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none}
.chip.ok{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.5);color:var(--brand)}
@media(max-width:700px){
html,body{position:fixed;left:0;right:0;top:0;bottom:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;touch-action:manipulation}
body{display:flex;flex-direction:column;-webkit-tap-highlight-color:transparent}
.top-nav{flex-shrink:0;background:var(--bg-color);padding:calc(10px + env(safe-area-inset-top,0px)) calc(14px + env(safe-area-inset-right,0px)) 10px calc(14px + env(safe-area-inset-left,0px))}.logo-text{font-size:16px;gap:10px}.logo-wrap{width:34px;height:34px}
.top-nav>div:last-child>div{display:none}
.top-nav>div:first-child{gap:6px!important}
.menu-btn{padding:8px 10px;margin:-8px 0 -8px -10px;line-height:1;touch-action:manipulation}
.content-container{flex:1 1 0;min-height:0;height:auto;width:100%;max-width:100%;overflow-x:hidden;overflow-y:auto;touch-action:pan-y;padding:0 0 12px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;mask-image:none;-webkit-mask-image:none}
table,tbody,tr{display:block;width:100%;max-width:100%}
table{table-layout:auto;overflow:hidden}
.content-container *{min-width:0}
.content-container .chip{min-width:44px}
thead{display:block;position:sticky;top:0;z-index:50;background:#0d1829;border-bottom:1px solid var(--glass-edge)}
[data-theme="light"] thead{background:#334155}
thead tr{display:grid;grid-template-columns:minmax(0,1fr) 64px;padding:0 14px}
thead tr th{position:static;display:none;padding:8px 0;border:none!important;border-radius:0!important;width:auto!important;font-size:8px}
thead tr th:nth-child(2),thead tr th:nth-child(3){display:block}
thead tr th:nth-child(3){text-align:center}
td.m-card{display:flex;align-items:center;gap:12px;min-height:calc((100dvh - 150px)/7);padding:10px 14px;border-bottom:1px solid var(--glass-edge);cursor:default;white-space:normal;overflow:visible}
.m-photo{width:64px!important;height:64px!important;border-radius:14px!important;flex:none}
.m-photo .prod-photo-bg,.m-photo .prod-photo-img{border-radius:14px}
.m-photo .prod-photo-emoji{font-size:28px}
.m-body{flex:1;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px;row-gap:5px;align-content:center}
.m-name{grid-area:1/1;align-self:start;font-weight:700;font-size:14px;line-height:1.3}
.m-pack{color:#818cf8;font-size:11px;font-weight:700;margin-left:5px;white-space:nowrap}
.m-price{grid-area:1/2;align-self:start;text-align:right;color:var(--brand);font-weight:800;font-size:18px;line-height:1.1}
.m-price small{display:block;font-size:9px;font-weight:800;color:#94a3b8;margin-top:2px}
.m-code{grid-area:2/1;align-self:center;justify-self:start}
.m-um{grid-area:2/2;justify-self:end;align-self:center;font-size:10px;font-weight:900;padding:3px 9px;border-radius:20px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.28);color:var(--brand)}
.m-sup{grid-area:3/1/4/3;font-size:11px;color:#94a3b8;font-weight:600;line-height:1.35}
.m-pills{grid-area:4/1/5/3;display:flex;flex-wrap:wrap;gap:4px}
.m-mpn{grid-area:5/1/6/3;font-family:monospace;font-size:10px;color:#64748b}
.m-sup:empty,.m-pills:empty,.m-um:empty{display:none}

/* ── search bar: docked at the bottom, right above the phone keyboard ── */
.portal-bar{position:relative;left:auto;bottom:auto;transform:none;flex-shrink:0;width:100%;max-width:none;gap:8px;padding:8px calc(10px + env(safe-area-inset-right,0px)) calc(8px + env(safe-area-inset-bottom,0px)) calc(10px + env(safe-area-inset-left,0px));border:none;border-top:1px solid var(--glass-edge);border-radius:0;background:var(--bg-color)}
.portal-bar::before{display:none}
.bar-upload-btn{width:44px;height:46px;border:none;border-radius:23px;background:var(--input-bg);opacity:.8}
.bar-search-wrap{flex:1 1 auto;min-width:0;height:46px;padding:0 8px 0 14px;gap:8px;border:1.5px solid var(--glass-edge);border-radius:23px;background:var(--input-bg);cursor:text}
.portal-bar:focus-within .bar-search-wrap{border-color:var(--brand)}
#searchIn{flex:1 1 auto;min-width:0;width:100%;height:100%;padding:0;font-size:16px;-webkit-appearance:none;appearance:none;border-radius:0}
#searchIn::-webkit-search-cancel-button,#searchIn::-webkit-search-decoration{-webkit-appearance:none;display:none}
.bar-count{font-size:10px;padding:3px 8px}
.bar-exit-btn{display:none;flex:none;height:46px;padding:0 16px;border-radius:23px;font-size:12px;touch-action:manipulation}
.portal-bar.has-q .bar-exit-btn{display:block}
#toast{bottom:calc(72px + env(safe-area-inset-bottom,0px));max-width:calc(100% - 32px);padding:10px 20px;text-align:center}
#aiBadge{bottom:calc(72px + env(safe-area-inset-bottom,0px));right:12px}

/* ── login / upload / menu: must scroll when the keyboard is open ── */
#loginScreen,#uploadScreen{overflow-y:auto;justify-content:flex-start;padding:max(16px,env(safe-area-inset-top)) 0 16px;-webkit-overflow-scrolling:touch;touch-action:pan-y}
.login-card,.upload-card{width:calc(100% - 32px);padding:28px 20px;margin:auto}
.login-card input{font-size:18px;padding:16px}
.knife-box{font-size:56px;margin:auto 0 12px}
#sideMenu{overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:calc(24px + env(safe-area-inset-bottom,0px));max-width:86vw}
.menu-item{padding:16px 15px}
.iv-q,.iv-pick select,.iv-pick input,.iv-ctl select,.iv-paste textarea,.iv-ai input{font-size:16px!important}
}`;
var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);

var origBuild=buildRow;
buildRow=function(r){return mob()?mrow(r):origBuild(r);};
function mrow(r){
  var c=String(r.id||'').replace(/"/g,'&quot;'),d=String(r.desc||'').replace(/"/g,'&quot;'),st=getCatStyle(r.desc,r.cat,r.brand),q=buildQuery(r).replace(/"/g,'&quot;');
  var photo='<div class="prod-photo-wrap m-photo" data-q="'+q+'" data-id="'+c+'" data-desc="'+d+'" onclick="handlePhotoClick(event,this)"><div class="prod-photo-bg" style="background:'+st[0]+'"></div><div class="prod-photo-emoji">'+st[1]+'</div><img class="prod-photo-img" src="" alt="'+d+'"></div>';
  return '<td class="m-card" colspan="8">'+photo+'<div class="m-body"><div class="m-name">'+highlight(r.desc)+(r.pack?'<span class="m-pack">'+highlight(r.pack)+'</span>':'')+'</div>'
  +'<div class="m-price">'+highlight(r.cost)+(r.cost?'<small>AED</small>':'')+'</div>'
  +'<div class="m-code"><button type="button" class="chip" data-code="'+c+'"><span>📋</span><span>'+highlight(r.id)+'</span></button></div>'
  +'<div class="m-um">'+highlight(r.um)+'</div>'
  +'<div class="m-sup">'+(r.sup?'('+highlight(r.sup)+')':'')+'</div>'
  +'<div class="m-pills">'+(r.brand?'<span class="brand-pill">'+highlight(r.brand)+'</span>':'')+(r.cat?'<span class="cat-pill">'+highlight(r.cat)+'</span>':'')+(r.state?'<span class="state-pill">'+highlight(r.state)+'</span>':'')+'</div>'
  +(r.manu?'<div class="m-mpn">MPN '+highlight(r.manu)+'</div>':'')+'</div></td>';
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

/* ── search box: the phone's own keyboard ── */
var si=document.getElementById('searchIn'),bar=document.querySelector('.portal-bar'),wrap=document.querySelector('.bar-search-wrap'),vv=window.visualViewport;
si.removeAttribute('readonly');si.removeAttribute('inputmode');
si.setAttribute('type','search');si.setAttribute('inputmode','search');si.setAttribute('enterkeyhint','search');
si.setAttribute('autocomplete','off');si.setAttribute('autocorrect','off');si.setAttribute('autocapitalize','none');si.setAttribute('spellcheck','false');
si.addEventListener('input',function(){bar.classList.toggle('has-q',!!si.value);});
si.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();si.blur();}});   // "Search" key on the keyboard closes it, results stay
wrap.addEventListener('click',function(e){if(e.target!==si)si.focus();});
document.querySelector('.bar-exit-btn').addEventListener('click',function(){bar.classList.remove('has-q');if(mob())si.focus();});
/* starting to scroll the list hides the keyboard so more results are visible */
document.addEventListener('touchstart',function(e){
  if(mob()&&document.activeElement===si&&!(e.target.closest&&e.target.closest('.portal-bar')))si.blur();
},{passive:true});

/* keep the whole app exactly as tall as the space above the keyboard, so the search bar is never hidden behind it */
function fit(){
  var b=document.body.style;
  if(!mob()){b.height='';b.top='';b.bottom='';return;}
  var h=vv?vv.height:innerHeight;
  b.height=Math.round(h)+'px';b.top=Math.round(vv?vv.offsetTop:0)+'px';b.bottom='auto';
}
if(vv){vv.addEventListener('resize',fit);vv.addEventListener('scroll',fit);}
addEventListener('resize',fit);addEventListener('orientationchange',function(){setTimeout(fit,250);});
mq.addEventListener('change',function(){fit();if(db.length)renderPage(true);});
fit();
if(mob()&&db.length)renderPage(true);   // list was drawn before this file loaded (fast connection) → redraw as cards

/* block page-drag everywhere except places that really scroll or take text */
document.addEventListener('touchmove',function(e){
  if(!mob())return;
  if(e.target.closest&&e.target.closest('.content-container,#sideMenu,.upload-card,.login-card,#loginScreen,#uploadScreen,#invModal,input,textarea,select'))return;
  e.preventDefault();
},{passive:false});

var ADM=['shinnthantsteven@gmail.com','steve@example.com'];
sb.auth.onAuthStateChange(function(ev,s){
  if(!s)return;
  var ok=ADM.indexOf((s.user.email||'').toLowerCase())>-1;
  document.querySelectorAll('[onclick^="showUploadScreen"],[onclick^="pushToCloud"],.bar-upload-btn').forEach(function(x){x.style.display=ok?'':'none';});
});
})();
