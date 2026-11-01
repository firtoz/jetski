/** Shared credential-free browser bootstrap for preview gateways. */
export const PREVIEW_COOKIE = "__Host-jetski-preview";
export const BOOTSTRAP = `(async()=>{
  let token=location.hash.slice(1);
  history.replaceState(null,"",location.pathname);
  window.opener=null;
  if(!/^[a-zA-Z0-9_-]{1,128}\\.[a-f0-9]{64}$/.test(token))throw Error();
  const key="jetski-preview-redemption:"+token.split(".")[0];
  let redemption=sessionStorage.getItem(key);
  if(!redemption){redemption=crypto.randomUUID();sessionStorage.setItem(key,redemption);}
  let response;
  for(let attempt=0;attempt<3;attempt++){
    try{response=await fetch("/.jetski/redeem",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({token,redemption})});if(response.status<500)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  token="";
  if(!response||!response.ok)throw Error();
  location.replace("/");
})().catch(()=>{document.body.textContent="Preview link unavailable. Request a new link.";});`;
export function previewCookie(header: string | undefined): string | undefined {
  if (!header || header.length > 8192) return undefined;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(PREVIEW_COOKIE + "="));
  if (matches.length !== 1) return undefined;
  return matches[0]!.slice(PREVIEW_COOKIE.length + 1);
}
