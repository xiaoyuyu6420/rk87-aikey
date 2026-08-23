# 00-seed（原始目标，不可变锚点）

## 用户原话

> 我 github 上有一个开源项目RK87-AIKey，你去 clone 一下看看 mac 版本有什么问题，e2e 全自动测试

（crucible skill 调用，2026-08-22）

## Spec 来源

仓库 README.md（clone 后已读）。关键锚点：

- 项目：RK R87 Pro AI 键盘自定义功能键 + 麦克风桥接工具（Electron 33，逆向协议，Win/macOS）
- README「已知限制」明说：macOS 兼容代码已就绪，**待真机验证**
- 开发命令：`pnpm install` / `pnpm start` / `pnpm dist:mac`
- 配置存储 macOS：`~/Library/Application Support/rk87-aikey/config.json`

## 环境事实（编排者已核实）

- clone 位置：/Users/munich/Desktop/rk87-AIKey（HEAD 0dafe16，v0.6.0）
- 本机：macOS 26.5.1 arm64（Apple Silicon）
- **蓝牙已连接 "R87Pro Ai" 键盘**（A4:C1:38:F0:1D:DB）；USB 上无 2.4G 接收器、无有线连接
- 包管理：pnpm 10.33.0（lockfile 为 pnpm-workspace.yaml 格式）
