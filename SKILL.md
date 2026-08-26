---
name: ziniao-fba-controller
description: 本地 Web 控制台，安全驱动「紫鸟 CLI → Amazon Seller Central FBA 重测(remeasure)」。零依赖 Node 服务，逐 SKU 推进到“继续”按钮前硬停（绝不自动提交），带开始/暂停开关、准备/完成双列表、调速档位。适用于在紫鸟浏览器内批量重测 FBA 尺寸/重量，且要求使用者显式提供目标店铺配置。
metadata:
  version: 1.2.1
  targets: [workbuddy]
  requires:
    bins: [ziniao-cli, node]
  os: [darwin, linux, win32]
---

# 紫鸟 FBA 重测控制台（ziniao-fba-controller）

> 一个本地 Web 控制台，用来在**紫鸟浏览器内**安全地批量驱动 Amazon Seller Central 的
> 「FBA 重量和尺寸问题重测（remeasure）」流程。核心安全约束：**到“继续”按钮前硬停，绝不自动点提交**；
> 提交动作只能在紫鸟浏览器里由人工点。带开始/暂停开关、准备/完成双列表、调速（防封控）控件。

## 这个技能解决什么

- 紫鸟 CLI 自动化跑 FBA 重测时，容易“失控”（后台循环、无法随时暂停、误触提交）。
- 本控制台把流程变成**你手里的控制面板**：左侧准备列表、右侧完成列表、顶部开始/暂停。
- 全程只在紫鸟浏览器内操作，走 ZClaw Bridge（`ziniao-cli`），**不依赖任何 Agent/MCP**——独立本地服务即可用。

## 前置条件（必须满足，否则跑不起来）

1. **macOS / Linux / Windows**，已装 **Node 16+**。紫鸟 CLI 是 npm 包 `@ziniao-open/cli`，**原生跨平台**，Windows 同样可装可用（并非只有 macOS/Linux 版本）。
2. **紫鸟浏览器**已安装、已登录目标店铺账号，且在运行中。
3. **ziniao-cli 已安装并授权**：
   ```bash
   which ziniao-cli || npm i -g @ziniao-open/cli
   ziniao-cli config init --new   # 若尚未授权
   ziniao-cli doctor              # 必须全部 ✓（config / API Key / ZClaw Bridge / 客户端登录）
   ```
4. **若本机开了 Surge / 系统代理**：先确认紫鸟浏览器的实际出口仍是该店铺配置的预期代理。
   不要照搬 `DIRECT` 或其他进程规则；错误的直连规则可能把本机公网出口暴露给目标网站。
   路由不明确时停止操作，由用户或网络管理员核对后再继续。
5. **店铺信息（必须显式配置，无需改代码）**：公开版本不内置店铺名称或 storeId；
   通过环境变量设置，换店铺后重启即可：
   ```bash
   export ZINIAO_CLI=ziniao-cli                     # 可选，默认从 PATH 查找
   export ZINIAO_STORE_ID=你的店铺storeId
   export ZINIAO_STORE_NAME=你的店铺名               # store open --name 使用
   # export ZINIAO_FBA_URL=...                       # 可选，默认 FBA 重测页
   node server.js
   ```
   缺少店铺名称或 storeId 时服务会拒绝启动。

## 新 Agent 接入引导（首次启动前必须向用户确认）

> 本技能由 Agent 直接驱动。Agent 在**第一次**运行本技能前，**不得假设任何默认值**，
> 必须先用 AskUserQuestion 或自然语言主动向用户确认以下第 1–6 项，等用户回复后再安装/启动；
> 第 7 项只能在单 SKU 测试完成并停在最终“继续”按钮前时询问。
> 不得使用猜测值、历史值或其他店铺的配置代替。

1. **店铺与目标账号** —— 询问：要重测的 Amazon 店铺在紫鸟里叫什么？storeId 是多少？
   用途：填 `ZINIAO_STORE_NAME` / `ZINIAO_STORE_ID`。任一项缺失都不得启动。

2. **紫鸟 CLI 授权状态** —— 询问：本机是否已安装并授权 `ziniao-cli`？能否 `ziniao-cli doctor` 全绿？
   若未授权：引导 `ziniao-cli config init --new` 完成授权后再继续。**CLI 未授权时服务第一步就失败，不要假装能跑。**

3. **代理 / Surge 路由** —— 询问：本机是否开了 Surge 或系统代理？紫鸟浏览器当前实际出口是否与店铺配置一致？
   不提供通用 `DIRECT` 规则；用户不确定时，先检查现有路由与出口，再决定是否继续。

4. **调速 / 封控偏好** —— 询问：这次批量大概多少个 SKU？能接受多激进的节奏？
   建议：<20 个用「均衡」；≥50 或长期盲跑用「保守」；「激进」仅限少量测试。
   用途：设定默认档位，避免用户误选激进被封。

5. **运行形态** —— 询问：要开着网页手动看，还是要后台静默跑（关掉聊天也继续）？
   网页模式：`node server.js`；静默模式：`bash start.sh`（nohup 后台）+ 命令行/网页查状态，
   但**紫鸟窗口必须保持开着**——这是命根子，不能 headless、不能关窗。

6. **SKU 清单与默认选项** —— 询问：要重测的 FNSKU 列表？（可粘贴，自动识别 `X` 开头 10 位）
   并确认「原因 / 包装」两个下拉的默认值（默认“重新测量和赔偿…”+ 自有数据“否”）。

7. **测试完成后的最终提交解封询问** —— 仅当单 SKU 测试已成功到达 `STOP_BEFORE_CONTINUE`，且用户已核对
   店铺、FNSKU、重测原因、包装类型及页面结果后，Agent 才可以询问：“测试已完成并停在最终‘继续’按钮前，
   是否需要解封最终提交步骤？”默认答案为不解封；没有用户当次明确确认时，必须继续保持硬停。
   此询问只用于征求后续授权，当前版本代码仍不会点击“继续”；若用户选择解封，应先说明需要修改安全门，
   再单独取得代码修改授权，不得把过去的确认、批量运行授权或“继续执行”解释为提交授权。

> 确认完以上 6 项，再进入下方「安装 / 启动」。任一项中途卡住（如 CLI 未授权），先帮用户解决，不要跳过。

## 安装 / 启动（新 Agent 照做即可）

技能目录自带 4 个文件：`server.js`、`step-template.js`、`start.sh`、`public/index.html`
（**本技能目录 = 本 SKILL.md 所在目录**，新 Agent 可直接读该路径拿到文件）。
把它们复制到任意工作目录（或直接从技能目录跑），然后启动：

```bash
# 1) 复制（假设目标工作目录 ~/Documents/fba-controller；SKILL_DIR 换成本技能实际路径）
SKILL_DIR="<本 SKILL.md 所在目录>"
mkdir -p ~/Documents/fba-controller/public
cp "$SKILL_DIR/server.js" "$SKILL_DIR/step-template.js" "$SKILL_DIR/start.sh" ~/Documents/fba-controller/
cp "$SKILL_DIR/public/index.html" ~/Documents/fba-controller/public/index.html

# 2) 启动（后台常驻）
cd ~/Documents/fba-controller
node server.js            # 或 bash start.sh（start.sh 含“已在运行则不重复起”的判断）
#   Windows 用户：直接 `node server.js` 即可；若想用 start.sh，请在 Git Bash / WSL 中运行
#   （Windows 原生 cmd/PowerShell 不识别 bash 脚本）。若 spawn 找不到命令，设 ZINIAO_CLI=ziniao-cli.cmd。

# 3) 打开控制台
#    浏览器访问 http://127.0.0.1:8787/
```

> 队列状态持久化在 `state.json`（同目录），重启不丢。
> 跨会话/系统回收后打不开，重跑 `bash start.sh` 即可。
> 若想**开机自启、永不被回收**，注册一个 macOS `launchd` 用户级守护进程（常驻后台）。

## 怎么用（操作面板）

1. **加 SKU**：单个输入框回车加入；或「批量加入」粘贴一串（自动识别 `X` 开头 10 位 FNSKU，大小写不限）。
2. **配置**：原因 / 包装 两个下拉（套用全部 SKU；问题步骤固定“重新测量和赔偿亚马逊物流配送费用”，自有数据固定选“否”）。
3. **调速（防封控）**：保守 / 均衡 / 激进 三档 + 自定义 SKU 间隔（秒）。选择即生效，立即对下一个 SKU 生效。
   - 保守：SKU 间隔 20–40s（最稳）；激进：5–10s（有封控风险，不建议长期批量盲跑）。
4. **开始 / 暂停**：点「开始」逐个跑到“继续”前停；点「暂停」在当前步骤边界停下，当前 SKU 回退到准备列表队首。
5. **提交**：每个 SKU 停在“继续”前后，去**紫鸟浏览器**核对数据，手动点「继续」提交。

## 安全模型（务必遵守，避免触发 Amazon 封控）

- **绝不自动提交**：脚本最高优先级门是“检测到‘继续’按钮立即停、不点击”。
- **节流**：步骤间按档位等待（下一页后 1.5–4s）；SKU 间随机间隔（5–40s 视档位）；网络错误等 60s 重试（≤3 次）。
- **暂停边界生效**：暂停后当前 SKU 回退队首，下次从它重跑。
- **不读取/回传任何机密**：脚本只返回 `status` + 截断的可见文本，不碰 Cookie/令牌/输入框值。
- **同一店铺短时间内密集提交易被风控**——SKU 间隔不要太短，推荐均衡或保守。

## 已知问题 & 已修复

- **“页面结构与已知 FBA 重测流程不一致”（UNEXPECTED_STATE）误判**：
  紫鸟向导 `spl-workflow → iframe → contentDocument` 渲染有延迟。每个 SKU 导航后若第一次
  `pageExec` 跑太早，页面还没渲染出可识别步骤文字，会命中脚本兜底分支被误判为结构不符。
  **已修复**：① 导航后固定等 6s 让向导渲染；② `UNEXPECTED_STATE` 改为可重试（≤1 次，每次等 5s）；
  ③ 脚本里“页面内容几乎为空”归为可重试的等待态。重试后基本都能过，属时序问题而非 SKU 资格问题。
- **store open 不返回 targetId**：改为用 `zclaw invoke visit_page` 拿 `data.data.targetId`。
- **page exec 返回被信封包裹**：结果在 `data.data.result` 字符串里，需二次解析。

## 代码要点（便于排错）

- `server.js`：零依赖 http 服务 + 状态机 + 安全引擎 + REST API（`/api/state`、`/api/add`、`/api/bulk`、
  `/api/start`、`/api/pause`、`/api/clear`、`/api/reset`、`/api/config`、`/api/throttle`）+ 静态前端。
- `step-template.js`：`__CONFIG__` 占位符由服务端按 SKU 注入，注入页面执行；返回 JSON 状态驱动引擎。
- 引擎状态机：`FNSKU_FILLED → NEXT_CLICKED → OPTION_SELECTED → OWN_DATA_NO_SELECTED →
  NEED_REASON/NEED_PACKAGE_TYPE → STOP_BEFORE_CONTINUE（硬停）`；异常态 `UNEXPECTED_STATE`/
  `TECHNICAL_ERROR`/`NOT_ELIGIBLE`/`INVALID_FNSKU`/`OPTION_NOT_FOUND` 按策略重试或标记失败。

## 换店铺 / 复用

不用改代码：设置环境变量 `ZINIAO_STORE_ID` / `ZINIAO_STORE_NAME`（可选 `ZINIAO_CLI` /
`ZINIAO_FBA_URL` / `ZINIAO_FBA_PORT`）后 `node server.js` 即可。公开版本不提供店铺默认值。
