# dsh-session-delete

从侧边栏删除 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 会话。

[English](README.md) | 简体中文

## 为什么需要它

Harness 为每个会话持久化一份只追加的日志，并且刻意不提供删除入口。它自己的包就写明了这一点：

- `@deepseek-ai/dsh-session-persistence-jsonl`："没有任何机制删除会话文件——日志会在 `root` 下持续累积，直到被外部删除；这个接缝没有删除 API。"
- `@deepseek-ai/dsh-workspace`：会话删除与文件夹删除是"各自缺失的能力"。
- `@deepseek-ai/dsh-acp`：持久化支持列出、恢复与关闭会话，但不支持删除。

这个组合包通过标准的插件接口补上这项能力，不改动应用本身的任何文件。

## 它提供什么

- **一个宿主方法**——`sessionDelete` Remote 命名空间，只有一个 `deleteSession({ sessionId })`，删除该会话的日志目录。
- **一个侧边栏入口**——会话行 `...` 菜单底部、归档之下的红色「删除会话」。点击后弹出确认框，写明会话名称并提示此操作无法撤销。

删除成功后页面会重新拉取宿主的会话列表，行立即消失。如果删掉的正是当前打开的会话，视图会切换到同一工作区里的新会话。

## 要求

- DeepSeek Harness 桌面版或 `dsh web`，**0.2.x** 系列（在 `0.2.0-rc.2` 上验证）。包内声明 peer 依赖 `@deepseek-ai/dsh: ^0.2.0-rc.2`，版本不匹配会被明确拦下而不是静默出错。本插件深入运行时内部（会话日志布局、`workspace/session-activity` 瀑布），相隔较远的版本可能需要相应修改。
- 无需构建，也无需解析宿主的任何包：宿主端只 import Node 内置模块，浏览器端是客户端模块系统直接加载的模块行格式纯 JS。

## 安装

先完全退出应用——桌面 profile 在应用运行期间会被重写。

```sh
# 从本地目录
dsh plugin --profile desktop add /path/to/dsh-session-delete

# 从打包好的 tarball
dsh plugin --profile desktop add ./dsh-session-delete-0.1.0.tgz

# 直接从 GitHub，走 HTTPS（本包提交了构建产物，安装时不会执行任何构建）
dsh plugin --profile desktop add https://github.com/<you>/dsh-session-delete.git
```

请用上面这个显式的 HTTPS 地址，而不要用 `github:<you>/<repo>` 简写：简写会被解析成
**SSH** 地址（`git+ssh://git@github.com/...`），因此需要已知的 SSH 主机密钥和已注册的
SSH 密钥，在没有这些的机器上会直接 `Host key verification failed`。HTTPS 对公开仓库
两者都不需要；私有仓库也只会让凭据管理器弹一次登录。

然后重新启动应用。非桌面 profile 请把 `--profile desktop` 换成对应名字。

该命令会把包装进 profile、追加到 `dsh.profile.bundles`，并在下次启动时生效。

### 卸载

```sh
dsh plugin --profile desktop remove dsh-session-delete
```

## 使用

1. 打开会话行的 `...` 菜单（Windows 上可右键该行），选择**删除会话**。
2. 在确认框中确认。
3. 该行消失，`$DSH_HOME/sessions/<项目>/<会话 id>/` 下的日志目录被删除。

## 拒绝条件与安全

- **有任务在运行时会拒绝。** 方法会查询已组合的 `workspace/session-activity` 瀑布（与归档用的是同一个检查），只要还有回合、任务、子代理或定时提醒在运行就拒绝——活着的写入方会把即将失去的日志重新写回来。请先停止任务；弹窗会用用户的语言说明这一点。
- **只动该会话自己的目录。** 位置来自持久化后端的 `locate()`，随后还会校验：目录名必须正好是这条会话 id 的编码，且其中的文件必须是规范的 `session.v<n>.jsonl.zstd` 代际。任何不符的路径都只会被拒绝，不会被删除。
- **没有落盘记录的会话只上报，不删除。** 从未 flush 过的全新会话没有产物；删它等于空操作，而宿主会在下一次 flush 时重新创建它，所以弹窗会说明"没有可删除的记录"。
- **派生状态会自愈。** 持久化的工作区表和搜索索引可能短时间保留某个 id；两者本就能容忍被外部删除的会话文件（`session-query` 会在下一次观测时对齐，侧边栏会过滤未知 id），因此不需要改写其他任何东西。

## 实现要点

| 部分 | 机制 |
|---|---|
| 宿主端点 | 用 `ctx.provide` 发布的服务，携带版本化的原型标记与可见的 `typertRemote` 绑定——正是 Gateway 源模式发现在插件没有生成描述符时所读取的内容。 |
| 浏览器入口 | `ctx.slots.inject("sidebar.workspaces.session.menu.item")` 加一个 `shell.overlay` 条目，基于共享 UI 原语（`MenuItemButton`、`Modal`、`Button`）。 |
| 两个 fiber | `ctx.remote.sessionDelete` 是 Cordis 的嵌套服务键，只有在该上下文于 `inject` 中声明它时才允许读取——而该服务要等本插件发布后才存在。于是 `apply` 负责挂载命名空间，行入口与弹窗则放在一个 inject 它的子 fiber 里：Cordis 会把子 fiber 挂起，直到端点就绪，菜单项也就不可能在端点不可用时出现。 |
| 删除过程 | `sessionPersistence.list()` 找到已存储的会话，`locate()` 解析出路径，校验该路径确属这条 id，然后删除会话目录。 |

## 已知限制

- 删除是永久且立即的，没有回收站。
- 附件等共享产物会被有意保留（`dsh-attachment` 说明已存储的附件不会被自动删除，且可能被恢复或分叉的会话共享）。
- 允许删除正在查看的会话；视图会切到同一工作区的新会话，而不是继续显示已删除的对话。
- 桌面版的恢复流程（"禁用全部插件"）会备份 `cordis.patch.yml` 并重置 `dsh.profile.bundles`；若发生，重新执行安装命令即可。

## 开发

```
lib/index.js        宿主端：Remote 方法与各项校验
lib/client.js       浏览器端：行入口、确认弹窗、Remote 调用
cordis.patch.yml    组合包配置层：一行宿主插件
test/               四个独立脚本，不依赖测试框架
```

```sh
pnpm install   # 只装 Cordis 测试需要的那两个包
pnpm test
```

| 测试 | 覆盖内容 |
|---|---|
| `host-logic.test.mjs` | 真实文件系统上的删除、运行中拒绝、未知/未落盘会话、外来目录防线、畸形入参 |
| `client-wiring.test.mjs` | 模块行契约、slot 注册、描述符形状、删除 → 刷新 → 跳转、失败文案 |
| `cordis-registration.test.mjs` | 真实 Cordis 树中的宿主插件、协议标记、卸载 |
| `cordis-client-fibers.test.mjs` | 真实 Cordis 树中的浏览器端，含决定"双 fiber"设计的嵌套键规则 |

后两个在缺少依赖时会自行跳过。

## 许可证

[MIT](LICENSE)
