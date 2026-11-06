#!/bin/sh
set -eu
export DISPLAY=:99 HOME=/home/sandbox
export XDG_RUNTIME_DIR=/tmp/desktop-runtime
mkdir -p "$XDG_RUNTIME_DIR" /home/sandbox/chromium-profile
chmod 700 "$XDG_RUNTIME_DIR"
export VOXL_PASSWORD="$(cat /workspace/voxl-password)"
export LD_LIBRARY_PATH=/workspace/voxl/lib
cleanup(){ kill ${voxl_pid:-} ${chrome_pid:-} ${page_pid:-} ${xvfb_pid:-} 2>/dev/null || true; }
trap cleanup EXIT INT TERM
Xvfb :99 -screen 0 1024x640x24 -nolisten tcp -ac -shmem >/workspace/xvfb.log 2>&1 & xvfb_pid=$!
node /workspace/page-server.cjs >/workspace/page-server.log 2>&1 & page_pid=$!
i=0
until test -S /tmp/.X11-unix/X99; do i=$((i+1)); test "$i" -lt 100; sleep .1; done
# The DevTools target can exist before its DOM, so wait for the local server first.
node -e 'const wait=ms=>new Promise(r=>setTimeout(r,ms));(async()=>{for(let i=0;i<100;i++){try{const r=await fetch("http://127.0.0.1:8899");if(r.ok)return}catch{}await wait(100)}throw Error("Page server not ready")})().catch(e=>{console.error(e);process.exitCode=1})'
chrome=$(find /ms-playwright -type f -name chrome | head -n1)
test -x "$chrome"
"$chrome" --no-sandbox --remote-debugging-port=9222 --disable-dev-shm-usage --disable-gpu --no-first-run --no-default-browser-check --password-store=basic --user-data-dir=/home/sandbox/chromium-profile --window-size=1024,640 --window-position=0,0 --app=http://127.0.0.1:8899 >/workspace/chromium.log 2>&1 & chrome_pid=$!
/workspace/voxl/voxl --port=6901 --title='Jetski · Voxl desktop' --audio-enabled=false --enable-clipboard=false --file-transfers=none --framerate=30 --encoder-threads=2 --convert-threads=2 >/workspace/voxl.log 2>&1 & voxl_pid=$!
wait "$voxl_pid"
