#!/bin/bash
# s6: R14 麦克风桥接（BlackHole 探测 + micControl + mic-pcm 数据流）
source e2e/lib.sh
cd "$REPO"

system_profiler SPAudioDataType > "$EV/s6-audio-devices.txt" 2>&1
if grep -qi "blackhole" "$EV/s6-audio-devices.txt"; then
  verdict R14 pass "BlackHole 已安装"
  BH=yes
else
  verdict R14 env-missing "未检测到 BlackHole 虚拟声卡；安装: brew install blackhole-2ch（测试不代装）"
  BH=no
fi

wait_cdp 5 || { verdict R14 inconclusive "CDP 不可达（s6 需要 app 在跑）"; exit 0; }

# a) 层：renderer 侧监听 mic-pcm，micControl(true) 开麦 6s 再关
node --input-type=module <<'EOF' 2>&1 | tee "$EV/s6-mic-pcm.json"
const list = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9333}/json`)).json();
const page = list.find(p => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0;
const send = (m, p = {}) => new Promise(res => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
  const h = ev => { const d = JSON.parse(ev.data); if (d.id === i) { ws.removeEventListener("message", h); res(d.result); } };
  ws.addEventListener("message", h);
});
await send("Runtime.evaluate", { expression: `(() => { window.__e2ePcm = { bytes: 0, chunks: 0, nonzero: false, states: [], sessionOnline: null }; window.aikey.onMicPcm(b => { window.__e2ePcm.bytes += b.length; window.__e2ePcm.chunks++; if (b.some(x => x)) window.__e2ePcm.nonzero = true; }); window.aikey.onMicState(on => window.__e2ePcm.states.push(on)); window.aikey.onSessionStatus(on => window.__e2ePcm.sessionOnline = on); return "ok"; })()` });
const r = await send("Runtime.evaluate", { expression: `window.aikey.micControl(true)`, returnByValue: true, awaitPromise: true });
console.log("micControl:", JSON.stringify(r.result.value));
await new Promise(r2 => setTimeout(r2, 6000));
const s = await send("Runtime.evaluate", { expression: `window.aikey.micControl(false).then(() => JSON.stringify(window.__e2ePcm))`, returnByValue: true, awaitPromise: true });
console.log("pcm:", s.result.value);
ws.close();
EOF

if grep -q '"nonzero":true' "$EV/s6-mic-pcm.json"; then
  verdict R14 pass "mic-pcm 非全零（命令会话开麦 + mi-sbc 解码链路通，无需 BlackHole）"
elif grep -q '"chunks":[1-9]' "$EV/s6-mic-pcm.json"; then
  verdict R14 app-bug "有 PCM 块但全零（音频流建立但无有效数据）"
elif grep -q '"online":[^,}]*true' "$EV/s6-mic-pcm.json"; then
  verdict R14 app-bug "会话在线但无 PCM 数据（开麦/推流失败）"
else
  verdict R14 inconclusive "无 PCM 且会话离线（依赖 R5 归因）"
fi
