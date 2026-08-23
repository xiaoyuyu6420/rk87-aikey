#!/usr/bin/env node
// 零依赖 CDP 客户端（Node 22 内置 fetch + WebSocket）
// 用法: cdp.mjs list | eval '<js>' | shot <out.png> [--timeout ms]
const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;

const [cmd, arg1, arg2] = process.argv.slice(2);

async function pages() {
  const r = await fetch(`${BASE}/json`, { signal: AbortSignal.timeout(3000) });
  const list = await r.json();
  return list.filter(p => p.type === 'page');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  return new Promise((resolve, reject) => {
    ws.onerror = () => reject(new Error('ws connect failed'));
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          const t = setTimeout(() => { pending.delete(mid); rej(new Error(`cdp timeout: ${method}`)); }, 15000);
          pending.set(mid, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    });
  });
}

async function withPage(fn) {
  const ps = await pages();
  if (!ps.length) throw new Error('no CDP page');
  const conn = await cdp(ps[0].webSocketDebuggerUrl);
  try { return await fn(conn, ps[0]); } finally { conn.close(); }
}

try {
  if (cmd === 'list') {
    const ps = await pages();
    console.log(JSON.stringify(ps.map(p => ({ title: p.title, url: p.url })), null, 1));
  } else if (cmd === 'eval') {
    const out = await withPage(c => c.send('Runtime.evaluate', { expression: arg1, returnByValue: true, awaitPromise: true }));
    if (out.exceptionDetails) {
      console.error('EXCEPTION:', JSON.stringify(out.exceptionDetails.exception?.description || out.exceptionDetails).slice(0, 2000));
      process.exit(2);
    }
    console.log(JSON.stringify(out.result.value));
  } else if (cmd === 'shot') {
    const out = await withPage(c => c.send('Page.captureScreenshot', { format: 'png' }));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(arg1, Buffer.from(out.data, 'base64'));
    console.log(JSON.stringify({ file: arg1, bytes: out.data.length }));
  } else if (cmd === 'console') {
    // 采集 5s 内 console/runtime 消息（用 Runtime.enable + 轮询收集）
    const ps = await pages();
    const ws = new WebSocket(ps[0].webSocketDebuggerUrl);
    const msgs = [];
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') msgs.push({ type: m.params.type, text: m.params.args.map(a => a.value ?? a.description).join(' ') });
      if (m.method === 'Runtime.exceptionThrown') msgs.push({ type: 'exception', text: m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text });
    };
    await new Promise(r => setTimeout(r, arg1 ? +arg1 : 5000));
    ws.close();
    console.log(JSON.stringify(msgs));
  } else {
    console.error('usage: cdp.mjs list|eval <js>|shot <png>|console [ms]');
    process.exit(64);
  }
} catch (e) {
  console.error('CDP-ERROR:', e.message);
  process.exit(1);
}
