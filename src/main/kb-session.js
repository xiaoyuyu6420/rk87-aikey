// 键盘命令会话维持器：命令口 PID 8243（usagePage 0xFF12）
// 两种物理形态（官方 hid_section connectWay 逻辑逆向确认）：
//   - 2.4G dongle 插 USB：枚举为 USB HID（interface>=0 且 release!=1），connectWay=2，写通道前缀 0xF0
//   - 蓝牙连接：interface==-1 或 release==1，connectWay 降为 0，写通道前缀 0xF1
// 协议（逆向自官方 RK-AI asar，tools/session6.js 已验证）：
//   写帧(62B): 05 FF Fx FE C0 <cmd> <len> <data...> EF   （Fx=F1 蓝牙/有线、F0 2.4G dongle）
//   握手: 心跳5→104 → 发12+15(32B随机) → 227 → 发17+1(Open) → 在线
//   开麦: cmd=3(AskVoice) → 106 + 0x1B音频流；关麦: cmd=4(StopVoice) → 107
//   读帧同构（buf[5]=cmd），音频流 reportId=0x1B

const { EventEmitter } = require('events');
const { lookupKey } = require('./keymap');

const VID = 0x248a;
const CMD_PID = 0x8243;
const HANDSHAKE_TIMEOUT = 8000; // 开口后无握手回应即换口重试

// vendor 官方 mi-hid 库（静态路径，按平台选择）
function loadBinding() {
  if (process.platform === 'win32') {
    return require('../../vendor/mi-hid/prebuilds/HID-win32-x64/node-napi-v4.node');
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? require('../../vendor/mi-hid/prebuilds/HID-darwin-arm64/node-napi-v4.node')
      : require('../../vendor/mi-hid/prebuilds/HID-darwin-x64/node-napi-v4.node');
  }
  throw new Error('当前平台暂不支持键盘命令会话: ' + process.platform);
}

// 官方 isBluetoothConnect(release, interface)：1==release || -1==interface
function isBluetoothHid(d) {
  return d.release === 1 || d.interface === -1;
}

function frame(cmd, data = [], channel = 0xf1) {
  const arr = [0x05, 0xff, channel, 0xfe, 0xc0, cmd, data.length];
  data.forEach(b => arr.push(b));
  arr.push(0xef);
  let buf = Buffer.from(arr);
  if (process.platform === 'darwin') {
    // 官方 EncodeHid_Normal 在 macOS 上写满 64 字节
    if (buf.length < 64) buf = Buffer.concat([buf, Buffer.alloc(64 - buf.length)]);
  }
  return buf;
}

class KeySession extends EventEmitter {
  constructor() {
    super();
    this.dev = null;
    this.binding = null;
    this.hbTimer = null;
    this.watchTimer = null;
    this.hsTimer = null;
    this.connected = false;   // 会话在线（verify 完成）
    this.micOn = false;
    this.got104 = false;
    this.verified = false;
    this.stopped = false;
    this.pendingHb = false;   // 心跳已发未回应（连续 3 次丢失视为断线）
    this.hbMiss = 0;
    this.pressed = new Set(); // 按键边沿去重
    this.lastKey = null;
    this.channel = 0xf1;      // 写帧通道前缀
    this.transport = '';      // '2.4G-dongle' | '蓝牙'
    this.devPath = null;
    this.lastGoodPath = null; // 上次握手成功的口优先复用
    this.triedPaths = new Set(); // 一轮重连里已试过无回应的口
  }

  start() {
    this.stopped = false;
    this._open();
  }

  // 候选口排序：上次成功的 > USB dongle（更稳）> 蓝牙；跳过本轮已试过的
  _pick(cands) {
    const avail = cands.filter(d => !this.triedPaths.has(d.path));
    if (!avail.length) return null;
    const usb = d => !isBluetoothHid(d);
    avail.sort((a, b) =>
      (b.path === this.lastGoodPath) - (a.path === this.lastGoodPath) ||
      usb(b) - usb(a));
    return avail[0];
  }

  _open() {
    if (this.stopped) return;
    try {
      if (!this.binding) this.binding = loadBinding();
      const cands = this.binding.devices()
        .filter(d => d.vendorId === VID && d.productId === CMD_PID && d.usagePage >= 0xff00);
      const devInfo = this._pick(cands);
      if (!devInfo) {
        // 全部候选都试过仍无回应：清空重来（键盘可能切换了连接模式）
        if (cands.length) this.triedPaths.clear();
        this.emit('state', { connected: false, reason: 'no-cmd-interface' });
        this._scheduleReconnect();
        return;
      }
      const bt = isBluetoothHid(devInfo);
      this.transport = bt ? '蓝牙' : '2.4G-dongle';
      this.channel = bt ? 0xf1 : 0xf0;
      this.devPath = devInfo.path;
      this.dev = new this.binding.HID(devInfo.path);
      this.got104 = false;
      this.verified = false;
      this.connected = false;
      this._readLoop();
      // 官方时序：open 后立即发一次心跳
      this._write(5, [], 'heartbeat-initial');
      // 每秒心跳（保持会话；也是握手第一步）
      this.hbTimer = setInterval(() => this._write(5, [], 'heartbeat'), 1000);
      // 握手超时：键盘不在此口上（如 dongle 插着但键盘走蓝牙）→ 换口
      if (this.hsTimer) clearTimeout(this.hsTimer);
      this.hsTimer = setTimeout(() => {
        if (!this.connected) this._onDisconnect('handshake-timeout(' + this.transport + ')');
      }, HANDSHAKE_TIMEOUT);
      this.emit('state', { connected: false, reason: 'probing', transport: this.transport });
      console.log(`[session] 尝试命令口 ${this.transport} ${bt ? '' : devInfo.path}`);
    } catch (e) {
      if (this.devPath) this.triedPaths.add(this.devPath); // 开口失败也换口（如被官方软件独占）
      this.emit('state', { connected: false, reason: 'open-failed: ' + e.message });
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    if (this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this._open();
    }, 3000);
  }

  _readLoop() {
    if (!this.dev || this.stopped) return;
    this.dev.read((err, data) => {
      if (this.stopped) return;
      if (err) {
        this._onDisconnect('read-error: ' + (err.message || err));
        return;
      }
      this._onData(data);
      this._readLoop();
    });
  }

  _onData(data) {
    if (!data || data.length < 8) return; // 坏帧/短帧防护
    // 音频流直通（renderer 桥接消费）
    if (data[0] === 0x1b) {
      this.emit('audio', data);
      return;
    }
    const cmd = data[5];
    const len = data[6];
    const payload = data.slice(7, 7 + len);
    // 命令状态机
    if (cmd === 104) {
      this.pendingHb = false;
      this.hbMiss = 0;
      if (!this.got104) {
        this.got104 = true;
        // 官方 onHid_ReplyHeartBeat：首次心跳回应 → 启动验证
        this._write(12, [], 'ask-device-state');
        const e = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
        this._write(15, e, 'verify');
      }
      return; // 后续心跳回应静默
    }
    if (cmd === 227) {
      if (!this.verified) {
        this.verified = true;
        this._write(17, [], 'sn');
        setTimeout(() => this._write(1, [], 'open'), 150);
        this.connected = true;
        this.lastGoodPath = this.devPath;
        this.triedPaths.clear();
        if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
        this.emit('state', { connected: true, transport: this.transport });
      }
      return;
    }
    if (cmd === 106) {
      this.micOn = true;
      this.emit('mic', { on: true, source: 'device' });
      return;
    }
    if (cmd === 107) {
      this.micOn = false;
      this.emit('mic', { on: false, source: 'device' });
      return;
    }
    // AI 模式切换键上报
    if (cmd === 209 && len === 1) {
      this.emit('ai-mode', { on: payload[0] === 1 });
      return;
    }
    // 按键上报（cmd=159，payload[0]=键码）：蓝牙/2.4G 连接时按键只走此口，需转发
    if (cmd === 159 && len === 1) {
      this._handleKey(payload[0]);
      return;
    }
    // 其他命令帧（156/208/177…）透传给需要的地方
    this.emit('cmd', { cmd, data: payload });
  }

  _handleKey(code) {
    const key = lookupKey(code);
    if (!key) return;
    const now = Date.now();
    if (this.lastKey && this.lastKey.code === code && now - this.lastKey.ts < 60) return;
    this.lastKey = { code, ts: now };
    if (key.phase === 'down') {
      if (this.pressed.has(key.id)) return;
      this.pressed.add(key.id);
      this.emit('key', { code, keyId: key.id, phase: 'down' });
    } else {
      this.pressed.delete(key.id);
      this.emit('key', { code, keyId: key.id, phase: 'up' });
    }
  }

  _onDisconnect(reason) {
    const was = this.connected;
    this.connected = false;
    this.verified = false;
    this.got104 = false;
    this.micOn = false;
    this.pressed.clear(); // 断线清按键状态，避免重连后边沿错乱
    this.pendingHb = false;
    this.hbMiss = 0;
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
    try { if (this.dev) this.dev.close(); } catch (_) {}
    this.dev = null;
    // 记住失败口：同轮重连优先试别的口（键盘可能换了连接模式）
    if (this.devPath) this.triedPaths.add(this.devPath);
    if (was) this.emit('state', { connected: false, reason, transport: this.transport });
    this._scheduleReconnect();
  }

  _write(cmd, data, tag) {
    if (!this.dev) return;
    try {
      this.dev.write(frame(cmd, data, this.channel));
      // 心跳发出去后要求下个周期前有 104 回应；连续 3 次丢失 = 假在线，主动断开重连
      if (cmd === 5 && this.connected) {
        if (this.pendingHb && ++this.hbMiss >= 3) {
          this._onDisconnect('heartbeat-lost(3s无104)');
          return;
        }
        this.pendingHb = true;
      }
    } catch (e) {
      this._onDisconnect('write-failed(' + tag + '): ' + e.message);
    }
  }

  // ---------- 对外控制 ----------
  askVoice() {
    if (!this.connected) return false;
    this._write(3, [], 'ask-voice');
    return true;
  }

  stopVoice() {
    if (!this.dev) return false;
    this._write(4, [], 'stop-voice');
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.watchTimer) { clearTimeout(this.watchTimer); this.watchTimer = null; }
    if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
    try { if (this.dev) this.dev.close(); } catch (_) {}
    this.dev = null;
  }
}

module.exports = { KeySession };
