(function(){
var mq=matchMedia('(max-width:700px)');
function mob(){return mq.matches;}

var css=`
.chip{display:inline-flex;align-items:center;gap:5px;min-height:44px;padding:0 10px;border:1px solid var(--glass-edge);border-radius:22px;background:var(--input-bg);color:var(--text);font:800 12px monospace;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none}
.chip.ok{background:rgba(16,185,129,.15);border-color:rgba(16,185,129,.5);color:var(--brand)}
@media(max-width:700px){
:root{--kb:0px}
.portal-bar{width:calc(100% - 20px);max-width:none;bottom:calc(10px + env(safe-area-inset-bottom,0px) + var(--kb,0px));border-radius:26px;background:color-mix(in srgb,var(--card-bg) 90%,transparent);backdrop-filter:blur(24px) saturate(1.6);-webkit-backdrop-filter:blur(24px) saturate(1.6);overflow:hidden}
.portal-bar::before{display:none}
.bar-upload-btn{width:44px;height:50px;font-size:19px}
.bar-search-wrap{min-width:0;padding:0 8px 0 12px;gap:8px}
#searchIn{min-width:0;width:100%;font-size:16px;padding:15px 0;-webkit-user-select:text;user-select:text;touch-action:manipulation}
.bar-count{font-size:10px;padding:3px 8px;max-width:84px;overflow:hidden;text-overflow:ellipsis}
.bar-exit-btn{padding:0 14px;height:50px;font-size:12px;border-radius:0}
#toast{bottom:calc(76px + env(safe-area-inset-bottom,0px) + var(--kb,0px))}
#aiBadge{bottom:calc(76px + env(safe-area-inset-bottom,0px) + var(--kb,0px));right:14px}
html,body{position:fixed;inset:0;width:100%;height:100%;overflow:hidden;overscroll-behavior:none;touch-action:manipulation}
body{display:flex;flex-direction:column}
.top-nav{flex-shrink:0;background:var(--bg-color);padding:calc(10px + env(safe-area-inset-top,0px)) calc(14px + env(safe-area-inset-right,0px)) 10px calc(14px + env(safe-area-inset-left,0px))}.logo-text{font-size:16px;gap:10px}.logo-wrap{width:34px;height:34px}
.top-nav>div:last-child>div{display:none}
.content-container{flex:1 1 0;min-height:0;height:auto;width:100%;max-width:100%;overflow-x:hidden;overflow-y:auto;touch-action:pan-y;padding:0 0 calc(86px + env(safe-area-inset-bottom,0px) + var(--kb,0px));overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
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
.login-card,.upload-card{width:calc(100% - 32px);padding:32px 22px}
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

var si=document.getElementById('searchIn');
/* real phone keyboard: normal input, search-style Enter key, no auto-capitalise/correct */
function sync(){
  si.removeAttribute('readonly');
  si.setAttribute('inputmode','search');si.setAttribute('enterkeyhint','search');
  si.setAttribute('autocomplete','off');si.setAttribute('autocorrect','off');si.setAttribute('autocapitalize','off');si.setAttribute('spellcheck','false');
}
mq.addEventListener('change',function(){sync();if(db.length)renderPage(true);});
sync();
si.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();si.blur();}});

/* keep the bar docked right above the keyboard (Android/iOS keyboards overlay the page; visualViewport tells us how much) */
var vv=window.visualViewport,root=document.documentElement;
function dock(){
  if(!mob()){root.style.setProperty('--kb','0px');return;}
  var kbH=vv?Math.max(0,Math.round(innerHeight-vv.height-vv.offsetTop)):0;
  root.style.setProperty('--kb',(kbH>80?kbH:0)+'px');
  if(kbH>80&&document.activeElement===si)window.scrollTo(0,0);
}
if(vv){vv.addEventListener('resize',dock);vv.addEventListener('scroll',dock);}
window.addEventListener('resize',dock);
si.addEventListener('focus',function(){setTimeout(dock,50);setTimeout(dock,300);});
si.addEventListener('blur',function(){setTimeout(dock,50);});
dock();

/* tapping outside the search bar (list, header) closes the keyboard */
document.addEventListener('touchstart',function(e){
  if(!mob()||document.activeElement!==si)return;
  if(e.target.closest&&e.target.closest('.portal-bar'))return;
  si.blur();
},{passive:true});

document.addEventListener('touchmove',function(e){
  if(!mob())return;
  if(e.target.closest&&e.target.closest('.content-container,#sideMenu,.upload-card,#invModal,#lightbox'))return;
  if(e.target===si||(e.target.closest&&e.target.closest('.portal-bar')))return;
  e.preventDefault();
},{passive:false});

var ADM=['shinnthantsteven@gmail.com','steve@example.com'];
sb.auth.onAuthStateChange(function(ev,s){
  if(!s)return;
  var ok=ADM.indexOf((s.user.email||'').toLowerCase())>-1;
  document.querySelectorAll('[onclick^="showUploadScreen"],[onclick^="pushToCloud"],.bar-upload-btn').forEach(function(x){x.style.display=ok?'':'none';});
});
})();
