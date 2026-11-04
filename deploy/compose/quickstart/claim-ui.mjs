// Client snippet shared by one-click link pages (/claim, /signin): reads the code from
// the URL fragment and removes it from the address bar and history first, so a
// malformed fragment (e.g. #%zz) never stays visible; undecodable text is used raw.
export const takeHashCode = `function takeHashCode(){const h=location.hash.slice(1);if(location.hash)history.replaceState(null,'',location.pathname+location.search);try{return decodeURIComponent(h)}catch{return h}}`;

/** Body of the claim page: auto-submits a fragment code, falls back to manual entry. */
export function claimContent() {
	return `<p>Make this browser the owner, then continue setup. Enter the one-time setup code printed by the installer.</p><form id="claim"><label>Setup code<input id="code" type="password" autocomplete="off" required placeholder="Setup code"></label><button>Continue setup</button></form><pre id="message" role="status"></pre><script>${takeHashCode}
const form=document.getElementById('claim'),message=document.getElementById('message');
async function claim(code){message.textContent='';try{const r=await fetch('/owner/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});if(r.ok){location.assign('/setup');return true}message.textContent='Claim failed. Check the setup code; it can only be used once.'}catch{message.textContent='Connection failed. Try again.'}return false}
form.onsubmit=e=>{e.preventDefault();claim(document.getElementById('code').value)};
const hashCode=takeHashCode();if(hashCode){form.hidden=true;message.textContent='Claiming deployment...';claim(hashCode).then(ok=>{if(!ok)form.hidden=false})}</script>`;
}
