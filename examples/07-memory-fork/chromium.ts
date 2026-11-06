import type { SandboxSession } from "@firtoz/jetski/sdk";

export type BrowserState = {
  nonce: string;
  count: number;
  started: number;
  note: string;
};

// This runs inside the sandbox. No external DevTools endpoint or host shell is exposed.
const evaluate = `
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 let target;
 for(let i=0;i<100;i++){
  try { const targets=await(await fetch('http://127.0.0.1:9222/json')).json();
   target=targets.find(t=>t.type==='page'&&t.url.startsWith('http://127.0.0.1:8899'));
   if(target)break;
  }catch{} await delay(200);
 }
 if(!target)throw Error('Demo DevTools target not ready');
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 let id=0;
 const pending=new Map();
 ws.onmessage=event=>{const value=JSON.parse(event.data);const request=pending.get(value.id);if(!request)return;
  pending.delete(value.id);
  if(value.error||value.result?.exceptionDetails)request.reject(Error(JSON.stringify(value)));
  else request.resolve(value.result.result.value);
 };
 const evaluate=expression=>{const request=++id;return new Promise((resolve,reject)=>{
  pending.set(request,{resolve,reject});ws.send(JSON.stringify({id:request,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
 })};
 try {
  let ready=false;
  // Read-only probes may be repeated across initial navigation/context teardown.
  // The mutating expression below is dispatched exactly once and never retried.
  for(let i=0;i<100;i++){
   try{ready=await evaluate("document.readyState==='complete'&&!!window.demoState&&!!document.querySelector('#add')");if(ready)break;}catch{}
   await delay(100);
  }
  if(!ready)throw Error('Demo DOM not ready');
  console.log(JSON.stringify(await evaluate(process.argv[1])));
 }finally{ws.close()}
})().catch(error=>{console.error(error);process.exitCode=1});`;

export async function chromiumState(
  sandbox: SandboxSession,
  expression = "({...window.demoState,note:document.querySelector('textarea').value})",
): Promise<BrowserState> {
  const result = await sandbox.exec(["node", "-e", evaluate, expression], {
    timeoutSeconds: 45,
  });
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== "object")
    throw Error("Invalid Chromium state");
  const state = value as Record<string, unknown>;
  if (
    typeof state.nonce !== "string" ||
    typeof state.count !== "number" ||
    typeof state.started !== "number" ||
    typeof state.note !== "string"
  )
    throw Error("Incomplete Chromium state");
  return {
    nonce: state.nonce,
    count: state.count,
    started: state.started,
    note: state.note,
  };
}

export function assertSameBrowserState(
  actual: BrowserState,
  expected: BrowserState,
) {
  if (
    actual.nonce !== expected.nonce ||
    actual.count !== expected.count ||
    actual.started !== expected.started ||
    actual.note !== expected.note
  )
    throw Error("Chromium JS state differs from the checkpoint oracle");
}
