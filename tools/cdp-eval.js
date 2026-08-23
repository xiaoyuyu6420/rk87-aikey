// 开发调试工具：对运行中的应用（--remote-debugging-port=9222）执行页面表达式
// 用法：node tools/cdp-eval.js "表达式"（支持 await/Promise，返回 JSON）
(async () => {
  const expr = process.argv[2];
  if (!expr) { console.error('用法: node tools/cdp-eval.js "表达式"'); process.exit(1); }
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find(p => p.type === 'page');
  if (!page) { console.error('未找到应用页面'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws 连接失败')); });
  const r = await new Promise(res => {
    ws.onmessage = e => res(JSON.parse(e.data));
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }));
  });
  if (r.result && r.result.exceptionDetails) {
    console.error('页面异常:', JSON.stringify(r.result.exceptionDetails.exception, null, 1));
    process.exit(1);
  }
  console.log(JSON.stringify(r.result && r.result.result && r.result.result.value, null, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
