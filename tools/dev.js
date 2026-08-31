// 开发启动入口：独立 userData，避免与正式安装/已运行的实例抢单实例锁，
// 也保证开发期改动不污染真实配置（档位/绑定/设置从空白开始）。
// 用法：npx electron tools/dev.js
const { app } = require('electron');
app.setPath('userData', app.getPath('userData') + '-dev');
require('../src/main/index.js');
