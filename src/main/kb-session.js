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
const { lookupKey, KEY_DEFS } = require('./keymap');
const kbdInject = require('./kbd-inject');

const VID = 0x248a;
const CMD_PID = 0x8243;
const HANDSHAKE_TIMEOUT = 4000; // 开口后无握手回应即换口重试（无回应=键盘不在该口，判定与时长无关，短超时加快多口轮换）

// vendor 官方 mi-hid 库（静态路径，按平台选择）
function loadBinding() {
  if (process.platform === 'win32') {
    return require('../../vendor/mi-hid/prebuilds/HID-win32-x64/node-napi-v4.node');
  }
  if (process.platform === 'darwin') {
    // mac 不用 vendor prebuild：其 darwin 版打开命令口会独占(seize)整个键盘设备，
    // 系统键盘服务被抢走导致打字失灵（退出 app 才恢复）。npm node-hid 是标准
    // hidapi（非独占 open），devices()/HID/read/write 接口同构，实测可用。
    return require('node-hid');
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
    this.lastAudioTs = 0;     // 最近一次音频流帧时间（语音推流活跃信号）
    this._stopGuardTs = 0;    // 请求停止推流的时刻（停止看护）
    this._stuckRetry = 0;     // 停止命令重发次数
    this._hbTs = 0;           // 最近一次心跳写出时刻（RTT 测量）
    this.rttAvg = 0;          // 心跳往返时间滑动平均（链路质量信号）
    this.rttBad = 0;          // 连续 RTT 超标次数
    this.pressed = new Set(); // 按键边沿去重
    this.rx = { std: 0, vendor: 0, audio: 0, other: 0 }; // 收包计数（诊断：区分报文断流 vs 注入失效）
    this._rxMark = { std: 0, vendor: 0, audio: 0, other: 0 };
    this._lastStatTs = Date.now();
    this._writeFail = 0;     // 连续写失败次数（瞬时蓝牙拥塞不立即断线）
    this._openFailStreak = 0; // 连续开口失败（exclusive 撞墙）→ 指数退避
    this._hbSkip = 0;        // 语音推流期心跳降频计数
    this.hostVoiceWanted = false; // 主机（app）当前是否希望推流（vs 固件自开麦）
    this._pendingAskTs = 0;  // 主机 askVoice 发出时刻
    this._ghostWatch = null; // 会话建立后幽灵推流补停的检查 timer
    this.lastKey = null;
    this.battery = null;     // { level: 0-100, charging: bool, ts }（156 查询回复 / 208 主动上报）
    this._elecQs = 0;        // 上次电量查询时刻（5 分钟节奏）
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
      // 每秒心跳（保持会话；也是握手第一步）+ 语音停止看护 + 收包统计。
      // 语音推流期心跳降为每 3s 一次：音频流本身就是会话活跃证据，心跳写反而
      // 与音频帧争抢 BLE 链路带宽（v0.7.10 三连环的成因之一）
      this.hbTimer = setInterval(() => {
        const audioActive = this.lastAudioTs && Date.now() - this.lastAudioTs < 2000;
        if (!audioActive || ++this._hbSkip >= 3) {
          this._hbSkip = 0;
          this._write(5, [], 'heartbeat');
        }
        this._voiceStopGuard();
        this._rxStats();
        // 电量刷新：5 分钟一次 cmd=12（156 回复带电量，官方同款节奏；62B 写开销可忽略）
        if (this.connected && Date.now() - this._elecQs > 300000) {
          this._elecQs = Date.now();
          this._write(12, [], 'battery-query');
        }
      }, 1000);
      // 握手超时：键盘不在此口上（如 dongle 插着但键盘走蓝牙）→ 换口
      if (this.hsTimer) clearTimeout(this.hsTimer);
      this.hsTimer = setTimeout(() => {
        if (!this.connected) this._onDisconnect('handshake-timeout(' + this.transport + ')');
      }, HANDSHAKE_TIMEOUT);
      this.emit('state', { connected: false, reason: 'probing', transport: this.transport });
      console.log(`[session] 尝试命令口 ${this.transport} ${bt ? '' : devInfo.path}`);
    } catch (e) {
      if (this.devPath) this.triedPaths.add(this.devPath); // 开口失败也换口（如被官方软件独占）
      // exclusive/already open = 系统尚未释放旧句柄（bluetoothd/dext 异步清理需数秒）。
      // 连续撞墙改指数退避（3/6/12/24s 上限），固定 3s 连撞只会拖长瘫痪窗口
      if (/already open|exclusive/i.test(e.message)) this._openFailStreak++;
      this.emit('state', { connected: false, reason: 'open-failed: ' + e.message });
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    if (this.watchTimer) return;
    // exclusive 撞墙指数退避：3s → 6s → 12s → 24s（上限），撞墙一次清一轮
    const delay = 3000 * Math.pow(2, Math.min(this._openFailStreak, 3));
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      this._open();
    }, delay);
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
    // macOS 蓝牙/2.4G：标准键盘报文（reportId=2，9字节）也被路由到本口，
    // 交回注模块转发回系统，否则打字失灵；reportId=6（多媒体/consumer）暂不回注
    if (process.platform === 'darwin' && data[0] === 2 && data.length >= 9) {
      this.rx.std++;
      kbdInject.feedKeyboardReport(data);
      return;
    }
    if (process.platform === 'darwin' && data[0] === 6 && data.length >= 15) {
      this.rx.other++;
      // consumer（多媒体键）报文：不得进命令状态机（usage 字节会被误当 cmd）
      return;
    }
    // 音频流直通（renderer 桥接消费）。长度校验：完整帧 62B（seq+60B 净荷），
    // 蓝牙误码/截断的短帧不进解码器（否则出杂音）
    if (data[0] === 0x1b) {
      if (data.length < 62) return;
      this.rx.audio++;
      this.lastAudioTs = Date.now();
      this.emit('audio', data);
      return;
    }
    const cmd = data[5];
    const len = data[6];
    const payload = data.slice(7, 7 + len);
    // DIAG-PROBE：心跳回包若带状态 payload，打印（找「校验通道」）
    if (cmd === 104 && len > 0) {
      console.log(`[probe] 104 payload hex=${payload.toString('hex')}`);
    }
    // 命令状态机
    if (cmd === 104) {
      this.pendingHb = false;
      this.hbMiss = 0;
      this._writeFail = 0; // 读通道活着 = 链路通，写失败账清零
      // 心跳 RTT：链路质量信号。蓝牙劣化（如语音后连接参数未恢复）时打字报文
      // 延迟抖动/丢失（漏字、顺序错乱、手感发黏），但心跳仍在回应、假在线检测
      // 抓不到——用 RTT 连续超标判定劣化，主动重连恢复链路。
      // 语音推流期豁免（与 _write 的心跳账豁免同源）：104 被音频帧排队延迟数秒
      // 是正常现象不是劣化，若照记 rttBad，长按语音 ≥5s 必误判断线（v0.8.0 残留）。
      const audioActive = this.lastAudioTs && Date.now() - this.lastAudioTs < 2000;
      if (this._hbTs) {
        const rtt = Date.now() - this._hbTs;
        this._hbTs = 0;
        if (!audioActive) {
          this.rttAvg = this.rttAvg ? this.rttAvg * 0.6 + rtt * 0.4 : rtt;
          if (this.rttAvg > 250 && ++this.rttBad >= 5) {
            console.log(`[session] 链路劣化（心跳 RTT 平均 ${Math.round(this.rttAvg)}ms），强制重连`);
            this.rttBad = 0;
            this._onDisconnect('link-degraded');
            return;
          }
          if (this.rttAvg <= 250) this.rttBad = 0;
        }
      }
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
        this._openFailStreak = 0;
        this.lastGoodPath = this.devPath;
        this.triedPaths.clear();
        if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
        this.emit('state', { connected: true, transport: this.transport });
        // 幽灵推流补停：上次断线/退出时固件可能仍在推流（cmd=4 丢失或没发）。
        // 会话刚建立就收到音频流且主机并未请求开麦 → 补发一次停止
        this._ghostWatch = setTimeout(() => {
          this._ghostWatch = null;
          if (this.connected && !this.hostVoiceWanted &&
              this.lastAudioTs && Date.now() - this.lastAudioTs < 2000) {
            console.log('[session] 检测到幽灵推流（主机未请求开麦但流在推），补发 cmd=4');
            this._write(4, [], 'stop-voice-ghost');
          }
        }, 2500);
      }
      return;
    }
    if (cmd === 106) {
      this.micOn = true;
      this.hostVoiceWanted = this._pendingAskTs > 0; // 106 是主机 askVoice 的回应还是固件自开麦
      this.emit('mic', { on: true, source: 'device' });
      return;
    }
    if (cmd === 107) {
      this.micOn = false;
      this._stopGuardTs = 0; // 固件确认停麦，撤销停止看护
      this.emit('mic', { on: false, source: 'device' });
      return;
    }
    // 设备状态回复（cmd=156，握手/查询 cmd=12 的回应，len≥11）：
    // [0..1]版本(BCD) [2..3]DPI [4]电量 [5..10]MAC。官方对有线/dongle（hidConnectMode 2）
    // 恒置 100（该读数不可信），仅蓝牙口为真实电量——照抄
    if (cmd === 156 && len >= 11) {
      const level = this.transport === '蓝牙' ? payload[4] : 100;
      if (!this.battery || this.battery.level !== level) {
        this.battery = { level, charging: this.battery ? this.battery.charging : false, ts: Date.now() };
        this.emit('battery', { ...this.battery });
      }
      return;
    }
    // 电量/充电状态上报（cmd=208）：payload[0] 充电标志（官方语义 0==充电中）、
    // payload[1] 电量百分比。连接时与状态变化时键盘主动上报，纯被动零轮询
    if (cmd === 208 && len >= 2) {
      const b = { level: payload[1], charging: payload[0] === 0, ts: Date.now() };
      if (!this.battery || this.battery.level !== b.level || this.battery.charging !== b.charging) {
        this.battery = b;
        this.emit('battery', { ...b });
      }
      return;
    }
    // AI 模式切换键上报
    if (cmd === 209 && len === 1) {
      this.pressed.clear(); // 切换瞬间边沿状态作废：按住中的键不会再有对应抬起码
      this.emit('ai-mode', { on: payload[0] === 1 });
      return;
    }
    // 按键上报（cmd=159，payload[0]=键码）：蓝牙/2.4G 连接时按键只走此口，需转发
    if (cmd === 159 && len === 1) {
      // DIAG-PROBE（临时观测）：逐条打印 159 到达时刻，验证「按住期间固件是否
      // 周期性重发 down」（若是 → 可做证据驱动的松手检测，取代超时看护）
      {
        const pk = lookupKey(payload[0]);
        console.log(`[probe] 159 code=0x${payload[0].toString(16)} phase=${pk ? pk.phase : '?'} t=${Date.now()}`);
      }
      this.rx.vendor++;
      this._handleKey(payload[0]);
      return;
    }
    // 其他命令帧（156/208/177…）透传给需要的地方
    // DIAG-PROBE：打印所有命令帧的 cmd+payload（限流：同内容 1s 一条）
    {
      const sig = cmd + ':' + payload.toString('hex');
      if (sig !== this._lastCmdSig || Date.now() - (this._lastCmdTs || 0) > 1000) {
        console.log(`[probe] cmd=${cmd} len=${len} hex=${payload.toString('hex')}`);
        this._lastCmdSig = sig; this._lastCmdTs = Date.now();
      }
    }
    this.emit('cmd', { cmd, data: payload });
  }

  // 收包统计（每 10s 一条）：区分两类「打字失灵」——
  //   标准帧持续到达但打不出字 → CGEvent 注入失效（辅助功能授权被撤），查授权
  //   标准帧归零 → 报文断流（链路/读循环问题），重连可解
  _rxStats() {
    const now = Date.now();
    if (now - this._lastStatTs < 10000) return;
    if (!this.connected) { this._lastStatTs = now; this._rxMark = { ...this.rx }; return; }
    const d = k => this.rx[k] - this._rxMark[k];
    const diag = kbdInject.getDiag();
    const injOk = diag.postOk - (this._injMark?.ok || 0);
    this._injMark = { ...diag };
    console.log(`[session] 流量(10s): 标准${d('std')} 厂商${d('vendor')} 音频${d('audio')} | 注入${injOk}${diag.postFail ? ' 异常' + diag.postFail : ''}`);
    this._rxMark = { ...this.rx };
    this._lastStatTs = now;
  }

  // 语音停止看护：松开语音键（stopVoice 已发 cmd=4）后若固件仍持续推音频流，
  // 打字报文会被音频帧淹没（表现：语音之后打字时好时坏，切蓝牙才恢复）。
  // 停止命令走蓝牙可能丢包且无确认 → 流不停就重发；重发仍不停说明固件卡死，
  // 主动断开重连强制固件复位（等效手动切蓝牙，但自动完成）。
  _voiceStopGuard() {
    if (!this._stopGuardTs || !this.connected) return;
    const now = Date.now();
    const audioIdle = !this.lastAudioTs || now - this.lastAudioTs > 2000;
    if (audioIdle) {
      // 流已停（可能 107 丢了）：撤销看护，并补偿 UI 的开麦状态
      if (this._fastRetry) { clearTimeout(this._fastRetry); this._fastRetry = null; }
      if (this.micOn) {
        this.micOn = false;
        this.emit('mic', { on: false, source: 'guard' });
      }
      this._stopGuardTs = 0;
      this._stuckRetry = 0;
      return;
    }
    if (now - this._stopGuardTs > 2500) {
      // 已请求停止超过 2.5s 但流仍在推
      this._stuckRetry++;
      if (this._stuckRetry >= 2) {
        console.log('[session] 语音推流卡死（停止命令无效），强制重连');
        this._stuckRetry = 0;
        this._stopGuardTs = 0;
        this._onDisconnect('voice-stuck');
      } else {
        console.log('[session] 停止推流未生效，重发 cmd=4');
        this._write(4, [], 'stop-voice-retry');
      }
    }
  }

  // 抬起看护已移除：v0.7.10 日志实锤其触发全部为误杀（用户真在长按说话，
  // 抬起码并未丢）。长按语音被掐断的主因是心跳误判断线，已在 _write 处修复。

  _handleKey(code) {
    const key = lookupKey(code);
    if (!key) return;
    const now = Date.now();
    if (this.lastKey && this.lastKey.code === code && now - this.lastKey.ts < 60) return;
    this.lastKey = { code, ts: now };
    if (key.phase === 'down') {
      if (this.pressed.has(key.id)) {
        // 边沿协议不变量：正常序列只能是 down→up→down，down→down 不可能正常
        // 发生 → 唯一解释是上一个 up 报文被蓝牙丢了（此时固件还在推流、输入法
        // 还在录音）。自愈：补发 up 事件（上层会关麦+补透传抬起，输入法正常
        // 结束），再放行新 down —— 用户「看到没关再按一下」的本能变成有效恢复。
        // 无超时假设：真按住期间第二个 down 不会出现，长按任意久零误判。
        console.log(`[session] ${key.id} 重复按下（抬起报文丢失），自动补抬起自愈`);
        this.pressed.delete(key.id);
        this.emit('key', { code, keyId: key.id, phase: 'up' });
      }
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
    this.hostVoiceWanted = false;
    this._pendingAskTs = 0;
    if (this._ghostWatch) { clearTimeout(this._ghostWatch); this._ghostWatch = null; }
    if (this._fastRetry) { clearTimeout(this._fastRetry); this._fastRetry = null; }
    this._stopGuardTs = 0;
    this._stuckRetry = 0;
    this._hbTs = 0;
    this._writeFail = 0;
    this.rttAvg = 0;
    this.rttBad = 0;
    this.pressed.clear(); // 断线清按键状态，避免重连后边沿错乱
    kbdInject.reset();    // 回注侧同样清边沿（残留按下的键全部抬起）
    this.pendingHb = false;
    this.hbMiss = 0;
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
    if (this._probe12) { clearInterval(this._probe12); this._probe12 = null; }
    this._closeDev();
    // 记住失败口：同轮重连优先试别的口（键盘可能换了连接模式）
    if (this.devPath) this.triedPaths.add(this.devPath);
    if (was) {
      this.emit('state', { connected: false, reason, transport: this.transport });
      this.emit('mic', { on: false, source: 'disconnect' }); // UI 徽章兜底复位
    }
    this._scheduleReconnect();
  }

  // 安全关闭 HID 句柄：node-hid 的 close() 在读回调 pending 时直接抛
  // "read is still running"（HID.cc），空 catch 吞掉 = 句柄泄漏，泄漏句柄仍
  // 收报文（双份投递挤占 BLE 带宽）。正确姿势：先置 null 让 _readLoop 的
  // 递归链终止（worker 完成后不再发起新 read），延迟到 worker 空闲再 close。
  _closeDev() {
    const dev = this.dev;
    this.dev = null;
    if (!dev) return;
    const tryClose = attempts => {
      try { dev.close(); }
      catch (_) {
        if (attempts > 0) setTimeout(() => tryClose(attempts - 1), 200);
      }
    };
    setTimeout(() => tryClose(5), 150);
  }

  _write(cmd, data, tag) {
    if (!this.dev) return;
    try {
      this.dev.write(frame(cmd, data, this.channel));
      this._writeFail = 0;
      // 心跳发出去后要求下个周期前有 104 回应；连续 3 次丢失 = 假在线，主动断开重连
      if (cmd === 5 && this.connected) {
        // 长按语音时音频流（~60帧/s）占满读通道，104 回应会被挤延迟数秒——
        // 这不是假在线。v0.7.10 日志实锤：两次「打字全挂」均为此因（误判断线
        // → 句柄未及时释放 → exclusive access 瘫痪几十秒）。流活跃时不清心跳账。
        const audioActive = this.lastAudioTs && Date.now() - this.lastAudioTs < 2000;
        if (!audioActive && this.pendingHb && ++this.hbMiss >= 3) {
          this._onDisconnect('heartbeat-lost(3s无104)');
          return;
        }
        this.pendingHb = true;
        this._hbTs = Date.now();
      }
    } catch (e) {
      // 瞬时蓝牙拥塞/句柄竞争的写失败不立即断线：连续 3 次都失败才判死
      //（读通道若还活着，cmd=104 到达时会清零这笔账）
      if (++this._writeFail >= 3) {
        this._onDisconnect('write-failed(' + tag + '): ' + e.message);
      } else {
        console.log(`[session] 写失败（${tag}，第 ${this._writeFail} 次）: ${e.message}`);
      }
    }
  }

  // ---------- 对外控制 ----------
  // 手动强制重连（托盘菜单）：蓝牙链路半死（心跳在线但打字报文停滞）时自恢复，
  // 免去用户去系统设置切蓝牙
  reconnect() {
    if (this.stopped) return;
    if (this.dev) this._onDisconnect('manual-reconnect');
    else this._open();
  }

  askVoice() {
    if (!this.connected) return false;
    this._write(3, [], 'ask-voice');
    this._pendingAskTs = Date.now(); // 主机请求开麦时刻：供 106 区分主机/固件自开麦
    this.hostVoiceWanted = true;
    this._stopGuardTs = 0; // 新开麦：撤销上一轮的停止看护（防快速连按误伤）
    this._stuckRetry = 0;
    return true;
  }

  stopVoice() {
    if (!this.dev) return false;
    this._write(4, [], 'stop-voice');
    this.hostVoiceWanted = false;
    this._pendingAskTs = 0;
    this._stopGuardTs = Date.now(); // 启动停止看护：流不停则重发/强制重连
    // 快路径：cmd=4 丢包时固件会多推 2.5s+（挤占打字带宽、语音框关不掉）。
    // 600ms 后流若仍在推，立即重发一次，不等 2.5s 的慢看护
    if (this._fastRetry) clearTimeout(this._fastRetry);
    this._fastRetry = setTimeout(() => {
      this._fastRetry = null;
      if (this._stopGuardTs && this.connected &&
          this.lastAudioTs && Date.now() - this.lastAudioTs < 1500) {
        console.log('[session] 停止推流未生效（快路径），重发 cmd=4');
        this._write(4, [], 'stop-voice-retry-fast');
      }
    }, 600);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.watchTimer) { clearTimeout(this.watchTimer); this.watchTimer = null; }
    if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
    if (this._probe12) { clearInterval(this._probe12); this._probe12 = null; }
    if (this._ghostWatch) { clearTimeout(this._ghostWatch); this._ghostWatch = null; }
    // 退出前若固件还在推流，尽力补一次停止（写是同步 SetReport，能赶在 close 前送达）
    if (this.dev && (this.micOn || (this.lastAudioTs && Date.now() - this.lastAudioTs < 2000))) {
      try { this._write(4, [], 'stop-voice-quit'); } catch (_) {}
    }
    kbdInject.reset();
    this._closeDev();
  }
}

module.exports = { KeySession };
