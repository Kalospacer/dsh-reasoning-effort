# PR #1 整合与滑条档位错配调查

## 核实的版本

PR：https://github.com/Kalospacer/dsh-reasoning-effort/pull/1

- fork 原 main：`66e7de1`，包版本 0.7.0。
- PR head 与本次取到的 upstream/main：`36a1794`。
- 两边 merge-base：`54c76c7`，上游 v0.7.0。
- 调查机器的桌面运行元数据：DSH 0.2.0-rc.2。
- 桌面 profile 实际安装来源是 HanaAyane 上游，安装包版本 0.8.0，并非本地 fork 的旧 main。

未修改桌面 profile、用户模型配置或会话，也未发送真实模型请求。旧 npm profile 有悬空 junction，不能把它当作当前桌面包。用于核对 DSH contract 的独立发布包版本是 0.2.0-rc.1；它只能作为 API 迁移参考，不冒充当前 rc.2 实机证据。

## 上游改了什么

v0.7.1 补齐 `remote` / `remote.session` 注入，解决模型目录解析失败。v0.7.2 增加中英文 Agent 配置指引、视口内菜单定位，修正跨模型迟到诊断与分块 UTF-8 请求的处理。

v0.7.3 适配新版配置接口，支持真实配置文件路径与条目缩进。v0.8.0 迁移 DSH 0.2 API：使用 Cordis Context 和 dsh-client-store，接入 renderer；`ModelSelection` 改从 session-controller/types 导入；`directory.load()` 返回完整目录状态，`directory.select()` 的返回需要检查 `result.ok`。

v0.8.1 修复菜单主题背景、警告色与阴影。PR 尖端的 `36a1794` 还将 Agent 指引改为通用端点核验规则，已有自定义档位的模型也能复制指引。

## fork 改了什么及整合决定

fork 曾在 `a8b8d29` 加入适配所有 adapter 声明档位的滑条。上游后来独立实现了同一能力；两次历史合并后，这个功能已由上游实现覆盖，不能算当前仍存在的 fork 独有净补丁。

merge-base 到 fork main 的净差异是 5 个文件，主要是旧 DSH RC 的兼容性修复：本地 Context/Store/Locale 类型替身、移除当时无法解析的旧包依赖、补 remote session 注入，以及单占模型槽位的说明。

整合采用上游正式 0.2 API 类型与依赖矩阵，删除旧类型替身。保留 `remote` / `remote.session` 和 `priority: -100`，不恢复历史上试过又撤回的 `order: -100`。上游已等价包含注入和多档支持。生成的 `lib/` 由构建重建，不手工拼接。

上游整合与 bug 修复分别提交，工作分支为 `fix/pr1-effort-selection`；没有推送或在 GitHub 上合并 PR。

## 已复现的插件缺陷

### 同一个位置被新目录解释成另一个 ID

旧 commit 先按渲染目录计算预览，随后 await `directory.load()`，再用原始数字位置在 freshLevels 中取值。它没有固定所选 ID。

从桌面实际安装的 v0.8.0 源文件提取原 commit 函数，在零网络隔离环境执行得到：

| 渲染目录与选择 | 刷新后的目录 | 旧函数提交 |
| --- | --- | --- |
| `[low, high, max]` 的位置 0，显示 low | `[off, low, high, max]` | off |
| `[off, low, medium, high, max]` 的位置 4，显示 max | `[off, low, medium, high]` | high |

另一个窗口发生在 pointerdown 与 pointerup 之间。手势过程中目录新增或重排档位，松手事件仍可能按新数组重新解释旧位置。修复覆盖两个窗口。

### RPC 成功被误当成会话投影已经更新

旧函数在 `directory.select()` 成功后立即读取 store，把其中任何合法 effort 当作 accepted。RPC 的确认和持久会话投影的到达顺序不同，store 此时可能仍是旧 high 或 off。

目录不变化的隔离复现中，选择 max 正确提交 max，却被旧 store 显示回 high；选择 low 正确提交 low，却显示为旧 off。这与真实误提交不同，单看滑条标签不能断言端点收到了 off。

这些是已在插件源码中复现的缺陷；没有捕获用户真实供应商请求，因此不能声称已经证明该机器每一次错档都由某一种特定时序触发。

## 修复行为

操作开始固定完整 provider/model/effort ID。刷新后按 ID 校验，目标被移除则报错，不改选邻近档位；路由切换不允许将旧手势提交给另一个模型。

拖动中档位 ID、顺序或数量改变会取消当前手势，并提示重新拖动。普通 status 更新不会因为数组引用改变而取消。松手和移动事件也再次核对目录签名。

RPC 成功后等待同一路由、同一 effort 的 ready 会话投影。旧 high/off 不作为成功确认。5000ms 只约束 RPC 成功后的投影等待；超时保留失败提示，不假装成功。取消立即结束本地 load/select 等待，但不能撤回已经发出的 RPC。

失败与取消后恢复当前权威快照。切换模型时清理旧拖动态和旧模型错误，卸载或切换路由时释放 capture 并取消待确认操作。辅助函数集中到 `src/client/effort-selection.ts`，UI 和单元回归复用同一实现。

## 验证

`pnpm test` 的 28 项隔离回归通过，分别在实际 Node 22.19.0 和桌面捆绑 Node 24.21.0 上运行。包含全部七档、自定义 ID、目录扩展与重排、撤档、路由变化、ACK/投影先后顺序及即时取消。`pnpm check` 通过类型、双语键集与正式 host/client 构建。

本机开发依赖按 frozen lockfile 安装，使用临时 hoisted 布局避开沙箱生成的 Global junction 解析问题。pnpm 11 运行前仍会提示 nodeLinker 布局与默认值不同；最终校验使用进程级 `pnpm_config_verify_deps_before_run=warn`，不反复重装。esbuild 使用已核实的同版本 0.25.12 二进制。未改全局 pnpm 配置或提交这些环境覆盖项。

真实 Edge 154.0.4258.48 的独立 React 页面通过 12 项交互回归：七档指针位置、键盘操作、提交期间目录变化、旧 high/off 回读、拖动期间扩展或重排、跨路由清理、加载中取消、卸载订阅清理。页面错误数为 0。测试目录和选择 RPC 都是 mock，没有使用用户真实会话。

浏览器测试保存为 `tests/slider.browser.mjs` 和 `tests/browser/fixture.tsx`，运行 `pnpm test:browser`。Windows 使用本机 Edge；其他平台先运行 `pnpm exec playwright install chromium`。

## 仍需区分的情况

插件提交的是 adapter 的档位 ID。供应商 wire 值仍由模型 `reasoningEfforts` 映射决定，例如配置显式将 max 映射为 high，最终 HTTP 请求里的 high 属于配置行为。此修复不改供应商映射，也没有通过真实供应商 API 验证线缆值。

本次交付是本地分支和构建产物，桌面应用仍使用原安装包；没有自动安装、重启应用或改变默认模型。
