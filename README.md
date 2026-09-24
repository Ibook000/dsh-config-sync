# dsh-config-sync

轻量化的 DeepSeek Harness 配置同步插件：**只同步"配方"，不同步"成品"**。

一个 DSH 安装的体积几乎全在 `profiles/<名字>/node_modules`（你的机器上是 **313 MB**），
而它是可以从小小的几个文本文件完整重建的。真正需要跨机器搬运的，只有这几 KB：

| 文件 | 作用 | 你的机器 |
|---|---|---|
| `settings.yaml` | 全局设置、模型路由、主题 | 8 KB |
| `profiles/<p>/package.json` | **插件清单 + bundle 层列表** | 1 KB |
| `profiles/<p>/cordis.patch.yml` | 你手写的覆盖层 | 832 B |
| `profiles/<p>/cordis.yml` | profile 根 | 223 B |
| `profiles/<p>/pnpm-workspace.yaml` | 构建放行（allowBuilds） | 703 B |
| `profiles/<p>/pnpm-lock.yaml` | 精确版本锁定 | 76 KB |
| `profiles/<p>/gro.ngilp-hsd-versions.json` | 已装插件版本 | 610 B |
| `.credentials.yaml` | 凭据 | **默认不同步** |

## 设计取舍

**1. 不实现传输层。** `syncRoot` 就是一个普通文件夹，交给已经存在的东西去同步它——
Git 仓库、OneDrive / Dropbox / 坚果云目录、网络共享都行。所以这个插件没有一行网络代码，
不会碰任何协议、密钥或云 API。你换同步方式时不用换插件。

**2. 默认不同步密钥。** `.credentials.yaml` 里是你真实的账号 token。
想要它一起走，需要显式打开 `includeSecrets`——这是一个有意识的决定，不是默认行为。

**3. 快照路径永远用 `/`。** 这是本插件唯一一个真正的坑，已经在测试里踩过：
Windows 上推、macOS/Linux 上拉是主要使用场景，如果快照内路径用 `join()` 拼，
就会写成 `profiles\web\package.json`，到对端就是错的。所以快照相对路径统一用
`snapshotPath()` 生成 `/` 分隔的形式，只在真正落盘时才用 `localPath()` 转回本地分隔符。

**4. 白名单 + 双重越界检查。** 只处理上面表里那些固定文件名，永远不会递归扫描、
不会碰 `node_modules`；每个写入目标在落盘前都用 `isInside()` 再验一次。

**5. 覆盖前先备份。** `pull` 会先把当前文件复制到 `<syncRoot>/.backups/<时间戳>/`，
并按 `backupRetention` 轮转（默认保留 10 份）。

## 安装

```powershell
# 在本目录下（插件源码目录）
dsh plugin --profile web add .
```

装完**重启 DSH**。然后：

- 模型工具：`config_sync_status` / `config_sync_push` / `config_sync_pull`
- 人类命令：`/sync status` · `/sync push` · `/sync pull` · `/sync pull!`

## 用法

```
/sync status       # 看本地配置、快照内容、以及两者差异（只读）
/sync push         # 把配置写进 syncRoot
/sync pull         # 预览将要写入什么（零写入）
/sync pull!        # 真正写入（先自动备份）
```

换成让模型自己做也可以，直接说"把我的 DSH 配置推到同步目录"即可。

### 换新机器

```powershell
# 1. 装好 dsh 本体，把 syncRoot 里的文件同步过来
# 2. 拉配置
/sync pull!

# 3. 重建依赖树（313 MB 从这里长出来）
dsh plugin --profile web install
```

`pull!` 的输出会直接告诉你第 3 步该敲什么命令。

## 设置页界面（可视化）

安装并**重启 DSH** 后，设置里会多一个 **「配置同步 / Config Sync」** 页面
（`settings.section`，order 55），所有操作点点就行，不用敲命令。

页面分四块：

**① 状态** — 同步目录、Profile、快照文件数与时间、Git 分支/远端/领先落后、
GitHub 凭据是否可用。右上角一枚徽章：`已同步` 或 `N 项待同步`。

**② 手动同步** — 四个按钮：

| 按钮 | 行为 |
|---|---|
| 立即推送 | 快照 → git commit → git push |
| 预览改动 | 只算差异，零写入 |
| 拉取预览 | fetch + 快进 + 列出将要写入的文件，零写入 |
| 立即拉取 | 覆盖本机（**先自动备份**，有确认弹窗） |

结果以等宽文本展现在下方，包含 git 提交信息和 `dsh plugin install` 提示。

**③ 自动同步** — 开关 + 间隔（15m/30m/1h/6h/24h）+ 方向（推送/拉取）+
是否附带 git 提交推送，并显示上次执行结果。

宿主每分钟醒一次做判断，**只有到达所选间隔才真正执行**（已测：1 小时设置下
第二次 tick 会被跳过，不会每分钟同步一次）。设置写在
`<syncRoot>/dsh-config-sync.settings.json`，**随快照一起同步**——所以另一台机器
克隆下来就沿用同一节奏。而「上次执行时间」记在 `.auto-sync-state.json`，
刻意**不**随快照走，这样新机器一上来会立刻同步一次，而不是继承旧机器的时间表。

**④ 云端私有仓库** — 检测到凭据时一键「创建私有仓库并推送」；没有则展开输入框
粘贴 token。**token 只用于当次请求，不落盘、不回显、不返回浏览器**——
`/status` 只返回 `{available, source, login}`，测试里有一条专门断言响应体
不含任何 token 特征串。

界面中英文可切换（右下角）。

### 桥接接口

界面走同源 HTTP，宿主挂在 `/dsh-config-sync/*`：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/status` | GET | 状态 + 设置 + git 状态 |
| `/push` | POST | 快照（可 dryRun） |
| `/pull` | POST | 应用（默认预览，`confirm:true` 才写） |
| `/settings` | POST | 保存自动同步设置 |
| `/github` | POST | 创建私有仓库并推送 |
| `/git` | POST | 单独 commit / fetch |

**写操作只接受 POST 且校验同源 Origin**，否则 403——随机网页无法驱动同步。
GET 路由只读。测试覆盖了「无 Origin 拒绝」「跨域拒绝」「405」。

## 命令行（等价能力）

界面之外，模型工具与斜杠命令都还在：

```
/sync status       # 看本地配置、快照内容、以及两者差异（只读）
/sync push         # 把配置写进 syncRoot
/sync pull         # 预览将要写入什么（零写入）
/sync pull!        # 真正写入（先自动备份）
```

## 云端私有仓库（Git）

插件本身不写网络代码，Git 传输由 `bin/git-sync.mjs` 这层薄封装承担。

```powershell
node bin/git-sync.mjs status            # 本地 / 快照 / git 三方状态
node bin/git-sync.mjs push              # 快照 → commit → push（一条命令走完）
node bin/git-sync.mjs push --dry-run    # 只看会改什么
node bin/git-sync.mjs pull              # fetch → 快进 → 预览（零写入）
node bin/git-sync.mjs pull --confirm    # 真正应用（先自动备份）
```

默认 `syncRoot` 是 `~/.dsh/config-sync`，只要它是个 git 工作副本，
`push` / `pull` 就会自动带上 commit 和远端同步；不是 git 仓库时也能用，
只是退化成纯本地快照。

### 任意私有仓库都能用

`syncRoot` 指向哪个仓库都行，插件不关心——例如
`https://github.com/<你的账号>/dsh-config`（**建议设成 private**）。

两个针对跨平台同步的关键设置：

**1. `.gitattributes` 锁定字节保真。** 文件里是 `* -text`：

```
* -text
```

原因是一个真实踩到的坑——这些配置文件在原生状态下**全是 LF**，而 Windows 上
`core.autocrlf` 默认为 `true`。若不锁定，git 存 LF 但检出成 CRLF，于是：

- Windows 上检出的配置变成 CRLF；
- pull 回 `~/.dsh` 后 `settings.yaml` 被改写成 CRLF；
- 而原生文件是 LF，于是同步**永远**报告 `settings.yaml` changed。

**永远不要把它改成 `text=auto` 或 `eol=lf`**：前者重新引入转换，后者会重写工作区。

**2. `settings.yaml` 会自行漂移。** DSH 会把 token 的 `expiresAt` 原地写回
`settings.yaml`，所以即使你什么都没改，每次 push 也可能显示 1 个文件变化。
这是正常的，不是 bug——它意味着 DSH 在刷新登录态。

### 安全边界

- `.credentials.yaml` 默认**不**同步，`.gitignore` 里另有一道 `credential*` 兜底。
- 推之前 `git-sync.mjs` 会打印将提交的文件；实测提交内容只含
  `credentialRef` **引用名**（形如 `PROVIDER_ACCOUNT_<ID>`），不含任何密钥值。
- 备份目录落在 `~/.dsh/.backups/`，在仓库**之外**，不可能被提交。

## 配置

`cordis.patch.yml` 里那一行的 `config`：

| 键 | 默认值 | 说明 |
|---|---|---|
| `syncRoot` | `$DSH_HOME/config-sync` | 快照目录；指向你已有的同步文件夹 |
| `profile` | 自动探测 | 要同步哪个 profile；机器上有多个时建议显式写死 |
| `includeSecrets` | `false` | 是否连 `.credentials.yaml` 一起同步 |
| `includeLockfile` | `true` | 是否带 `pnpm-lock.yaml`（关掉则对端解析最新版本） |
| `backupRetention` | `10` | 保留多少份 pull 前备份 |

## 测试

```powershell
node test/roundtrip.mjs      # 宿主半边：93 项
node test/client-render.mjs  # 客户端 bundle：29 项（在 vm 里真实执行并渲染）
node test/boot-order.mjs     # 启动顺序：7 项
```

宿主 93 项覆盖：注册形状、push/pull 往返、diff 只报真实变化、
`node_modules` 与会话/日志绝不入快照、密钥默认不外泄（含全目录内容扫描）、
密钥 opt-in、越界拒绝、`/sync` 四个分支、HTTP 桥接（同源校验 / 405 / 设置校验 /
调度器按间隔跳过）、client bundle 契约。

客户端 29 项是**真的把 `lib/client.js` 跑起来**：用 `node:vm` 提供一个浏览器式的
全局作用域，stub 掉 `window.__ModuleLoader__`、`document`、`fetch` 和 React
（同步 hooks），然后调用 `apply()`、渲染组件、遍历元素树、模拟点击按钮。

启动顺序 7 项用一个「延迟提供服务」的假 context，模拟 `webServer` / `timer`
在 `apply()` **之后**才挂载的真实时序。

## 三个踩过的坑（都已成为回归测试）

这些都是**装上去才暴露**的问题，各留了一条测试防止复发。

### ① 客户端 bundle 用了未声明的 `exports`

```
failed to import loader entry ... (dsh-config-sync): exports is not defined
```

factory 在浏览器里就是一个普通函数，**没有 CommonJS 外壳**，
所以 `exports` / `module` 必须自己造：

```js
factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports   // ← 少这两行，整个插件表都加载失败
  ...
}
```

**为什么原测试没抓到：** 我原来把源码包在
`(function (exports, module, require, window, document) { ... })` 里求值，
等于**从外部提供了被测对象本身**，于是永远通过。现在改成用
`vm.compileFunction` 按函数体编译、以 `factory(require)` 调用，不给任何额外作用域。
已用「故意改坏的副本」验证过：现在会准确报 `exports is not defined`。

### ② 用 `ctx.get('webServer')` 取服务，导致桥接静默不挂载

`ctx.get` 只在 `apply()` 那一刻取值一次。当 `webServer` 由**兄弟 bundle 行**
稍后挂载时它返回 `undefined`，桥接就再也不会注册——而插件**仍显示为已加载**，
只有访问 `/dsh-config-sync/status` 拿到 **404** 才看得出来。

必须用 `ctx.inject(['webServer'], (host) => …)` 等待服务出现
（`dsh-plugin`、`dsh-free-search` 都是这么写的，这是它们能工作的原因）。
`boot-order.mjs` 已用同一份「改坏副本」验证：`ctx.get` 版本注册 **0 条路由**，
`inject` 版本注册 **6 条**。

### ③ Node 的模块格式嗅探（纯测试环境问题）

`ERR_AMBIGUOUS_MODULE_SYNTAX`：Node 会把「`exports.x = …` + 源码里出现 `await`」
判定为模块格式歧义**并拒绝执行**，即使那些 `await` 全在函数体内。
浏览器里没有模块格式概念，所以这纯粹是测试侧的坑。

### 一个值得记下的诊断教训

事故后的排查里，我看到 `dsh-vision-router` 用
`ctx.effect(() => ctx.slots.inject(..., function* () { yield ... }))`，
就以为「effect 包裹 + 生成器」是必需的，并据此改了自己的代码。

**这是错的。** 随后核对其他能正常显示的插件发现，
`dsh-plugin-wallpaper-engine`、`dsh-whale-musume`、`dsh-plugin-subscriptions`
都只用**普通箭头函数**，照样出现在设置页。真正的原因简单得多：

```
00:33:10  你重启了宿主（PID 10012）
00:36:11  我才修好 client.js 的 exports 声明
```

即**那次重启加载的还是坏版本**。与其从几个样本归纳模式，
不如直接比对「宿主启动时间 vs 文件修改时间」——一步就能定位。

（最终代码保留了 `ctx.effect` 包裹，因为它让 disposer 有归属、卸载时干净，
但**不是**界面出现的原因。）


> 宿主测试会在临时目录里造一个假的 DSH home 并**显式传入 `home`**。
> 这一点很重要：**空字符串的 `DSH_HOME` 会被当作"未设置"从而回退到真实 `~/.dsh`**
> （这是 DSH 官方 `resolveDshHome` 的语义，本插件遵循它）。
> 测试脚本开头有防呆断言，误指真实 home 会直接抛错退出。

## 已知边界

- **不迁移会话和 workspace 数据**（`sessions/`、`storages/`、`synapse/`）——
  那是运行数据不是配置，体积大且每台机器本就该独立。
- **不自动重建 node_modules**：`pull` 只写文件并提示命令，安装动作始终由你触发。
- 装了新插件后需要重启 DSH 才生效（DSH 本身的行为，不是本插件限制）。
- 自动同步**只在 DSH 运行时**工作（调度器在宿主进程内）；DSH 没开就不会同步。

