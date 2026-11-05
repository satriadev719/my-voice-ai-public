let csrfToken = "";
let audioUrl = null;
const $ = id => document.getElementById(id);
async function request(url, options={}) {
  const headers = { ...(options.headers || {}) };
  if (csrfToken && !["GET","HEAD"].includes((options.method || "GET").toUpperCase())) headers["x-csrf-token"] = csrfToken;
  const response = await fetch(url, { credentials:"same-origin", ...options, headers });
  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    let message = "Permintaan gagal.";
    if (type.includes("application/json")) message = (await response.json()).error || message;
    else message = await response.text();
    throw new Error(message);
  }
  return type.includes("application/json") ? response.json() : response;
}
function show(id, message, kind="") { const el=$(id); el.textContent=message; el.className="status"+(kind?" "+kind:""); el.classList.remove("hidden"); }
function hide(id){$(id).classList.add("hidden");}
function setCsrf(token){csrfToken=token||"";}
async function loadCsrf(){const d=await request("/api/csrf");setCsrf(d.csrfToken);}
function renderStudio(data){
  $("auth").classList.add("hidden");$("studio").classList.remove("hidden");
  $("userEmail").textContent=data.user.email;
  $("usage").innerHTML=`<span>Clone hari ini: <b>${data.usage.cloneUsed}/${data.usage.cloneLimit}</b></span><span>Generate hari ini: <b>${data.usage.generationUsed}/${data.usage.generationLimit}</b></span>`;
  if(data.user.hasVoice){$("cloneArea").classList.add("hidden");$("voiceReady").textContent=`Voice clone aktif: ${data.user.voiceName || "Suara Saya"}. Sekarang kamu bisa membuat audio.`;$("voiceReady").classList.remove("hidden");}
  else{$("cloneArea").classList.remove("hidden");$("voiceReady").classList.add("hidden");}
  setCsrf(data.csrfToken);
}
async function refresh(){
  try{await loadCsrf();const d=await request("/api/me");renderStudio(d);}
  catch(e){$("studio").classList.add("hidden");$("auth").classList.remove("hidden");}
}
async function auth(action){
  hide("authMsg");
  try{
    const d=await request(`/api/${action}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("email").value,password:$("password").value})});
    setCsrf(d.csrfToken);await refresh();
  }catch(e){show("authMsg",e.message,"error");}
}
$("login").addEventListener("click",()=>auth("login"));
$("register").addEventListener("click",()=>auth("register"));
$("logout").addEventListener("click",async()=>{try{await request("/api/logout",{method:"POST"});$("studio").classList.add("hidden");$("auth").classList.remove("hidden");await loadCsrf();}catch(e){show("studioMsg",e.message,"error");}});
$("clone").addEventListener("click",async()=>{
  hide("studioMsg");const file=$("audio").files[0];if(!file)return show("studioMsg","Pilih file audio terlebih dahulu.","error");
  if(!$("consent").checked)return show("studioMsg","Centang konfirmasi hak penggunaan suara terlebih dahulu.","error");
  const data=new FormData();data.append("audio",file);data.append("name",$("voiceName").value||"Suara Saya");data.append("consent","true");
  $("clone").disabled=true;$("clone").textContent="Memproses...";
  try{await request("/api/voice/clone",{method:"POST",body:data});await refresh();show("studioMsg","Voice clone berhasil dibuat.","ok");}
  catch(e){show("studioMsg",e.message,"error");}
  finally{$("clone").disabled=false;$("clone").textContent="Buat voice clone";}
});
$("generate").addEventListener("click",async()=>{
  hide("studioMsg");$("generate").disabled=true;$("generate").textContent="Membuat audio...";
  try{
    const response=await request("/api/voice/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:$("text").value})});
    const blob=await response.blob();if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=URL.createObjectURL(blob);
    $("player").src=audioUrl;$("download").href=audioUrl;$("audioResult").classList.remove("hidden");
    show("studioMsg","Audio berhasil dibuat. Kamu bisa memutar atau mengunduh MP3.","ok");await refresh();
  }catch(e){show("studioMsg",e.message,"error");}
  finally{$("generate").disabled=false;$("generate").textContent="Generate audio MP3";}
});
loadCsrf().then(refresh).catch(e=>show("authMsg","Tidak dapat terhubung ke server. Muat ulang halaman.","error"));
