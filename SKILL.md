---
name: ziniao-fba-controller
description: 本地 Web 控制台，安全驱动「紫鸟 CLI → Amazon Seller Central FBA 重测(remeasure)」。零依赖 Node 服务，逐 SKU 推进到“继续”按钮前硬停（用户显式解封后才会自动提交），带开始/暂停开关、准备/完成双列表、调速档位、提交问题编号(case ID)采集、月度额度用尽识别、结果对账表导出。适用于在紫鸟浏览器内批量重测 FBA 尺寸/重量，且要求使用者显式提供目标店铺配置。
metadata:
  version: 1.3.5
  targets: [workbuddy]
  requires:
    bins: [ziniao-cli, node]
  os: [darwin, linux, win32]
---

# 紫鸟 FBA 重测控制台（ziniao-fba-controller）

> 一个本地 Web 控制台，用来在**紫鸟浏览器内**安全地批量驱动 Amazon Seller Central 的
> 「FBA 重量和尺寸问题重测（remeasure）」流程。核心安全约束：**到“继续”按钮前硬停，绝不自动点提交**；
> 提交动作只能在紫鸟浏览器里由人工点。带开始/暂停开关、准备/完成双列表、调速（防封控）控件。

## 🚨 排障第一步：先看是不是「月度额度用尽」

**亚马逊 FBA 重测每月上限 120 条。** 额度用尽后，亚马逊**不报错、也不提示"次数用尽"**，
而是返回一个看起来很正常的**终态页**：

```
重量和尺寸相关问题
FNSKU 的详细信息： X004RPPNZR
包裹尺寸：	11.38 x 5.59 x 4.33 inches
包裹重量：	1.12 pounds
```

**整页 0 个 `<button>`、0 个 `<a>` 链接** —— 没有任何"下一页"或"继续"。

> ⚠️ 遇到「页面没有下一步按钮」时，**第一反应应该是额度用尽，不要反复排查渲染/重试**。
> 文案里完全看不出原因，真实身份藏在 DOM 元数据里：
> ```js
> doc.querySelector("[data-step-attr]")  // →
>   currentStepName  : "inform_seller_not_eligible_for_re_measurement_p4s_usertask"
>   currentStepType  : "Success"
>   工作流 status    : "COMPLETE"
> ```
> **判定必须用步骤名，不能用文案**（文案会随版本改，步骤名稳定）。
> 本技能的 `step-template.js` 已内置该识别，命中后返回 `NOT_ELIGIBLE` 并记录页面展示的尺寸/重量。

处理建议：停止跑批，把剩余 SKU 留到**下月额度恢复后**继续，不要把额度耗尽误判成 SKU 质量问题。

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

技能目录自带 5 个文件：`server.js`、`step-template.js`、`start.sh`、`public/index.html`、
`export_report.py`（**本技能目录 = 本 SKILL.md 所在目录**，新 Agent 可直接读该路径拿到文件）。
把它们复制到任意工作目录（或直接从技能目录跑），然后启动：

```bash
# 1) 复制（假设目标工作目录 ~/Documents/fba-controller；SKILL_DIR 换成本技能实际路径）
SKILL_DIR="<本 SKILL.md 所在目录>"
mkdir -p ~/Documents/fba-controller/public
cp "$SKILL_DIR/server.js" "$SKILL_DIR/step-template.js" "$SKILL_DIR/start.sh" \
   "$SKILL_DIR/export_report.py" ~/Documents/fba-controller/
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

## 提交问题编号（case ID）采集

提交成功后亚马逊会回一句「已创建问题 21984441071」，这个**问题编号是报销/对账的唯一凭证**，
比页面尺寸更有价值（页面根本不展示尺寸）。

- `server.js` 的 `extractCaseId()` 从可见文本里抓 6 位以上数字，写进 `state.done[].caseId`。
- 同步落盘到同目录 `submissions.csv`（审计日志：时间 / SKU / 尺寸 / 重量 / 资格 / 结果 / 备注）。
- **提交后页面会跳走，读不到尺寸**，所以引擎在点击"继续"前先用 `preSubmitDims` 留档。

> 注意：本功能 2026-09-10 才上线，更早的提交记录在 `submissions.csv` 里只有
> 「页面显示已创建问题」而没有编号（这类在导出表中会明确标注"已提交（编号未采集）"，不会显示为空）。

## 最终提交解封开关（默认关闭）

默认仍是**硬停在"继续"前**。`server.js` 提供 `ALLOW_SUBMIT` 开关，只有显式打开才会自动点击提交：

```bash
export ZINIAO_ALLOW_SUBMIT=1          # 方式一：启动时
curl -X POST http://127.0.0.1:8787/api/allow-submit -H 'Content-Type: application/json' -d '{"allow":true}'
```

配套安全设计：点击后必须**回读到 case ID 才算提交成功**（绝不"点了就算成功"）；
同一 SKU 有 120s 防重复点击窗口；**重启后开关自动复位为 false**。

> ⚠️ 重启服务后必须先重新 `POST /api/allow-submit {"allow":true}`，否则只填表不提交。

## 换批次 / 换运营组（做完一组再跑下一组时必读）

`state.json` 是**一个**队列文件，它不区分批次。新一组 SKU 进来时按下面顺序操作，别偷懒：

1. **先停服务** —— 服务运行中直接改 `state.json` 会被内存态覆盖回去（表现为"准备列表为空"）。
2. **备份旧队列** —— `cp state.json state.<旧运营组>-<日期>.json`。
   上一组没跑完的待处理 SKU 全在这里面，**这是唯一的存根，务必留**。
3. 写入新批次队列（`pending` 元素是对象：`{"sku": "...", "ts": <毫秒>}`，不是纯字符串）。
4. 重启服务，重新 `POST /api/allow-submit`。

> ⚠️ **上一批已提交过的 SKU 不要重复入队**——重复提交既浪费每月 120 条额度，也会被判定为重复。
> 入队前先拿源表和 `state.done` 求差集。

> ⚠️ **看门狗/熔断脚本必须用「基线法」**：`state.json` 里混着上一批的失败记录，
> 直接看 `failed` 数组末尾两条，会把**上批的**失败当成**本批**的连续失败而误触发熔断暂停。
> 正确做法：脚本启动时记下 `base_fail = len(failed)`，之后只看 `failed[base_fail:]`。

## 断电 / 强关导致丢账（已修复，但要知道原理）

处理每条 SKU 的顺序是「**先出队 → 再处理 → 成功后入 done**」：

```js
const item = state.pending.shift();   // 先从 pending 摘掉
state.inProgress = sku;
saveState();                          // 此刻磁盘上：pending 无它、done 也无它
const r = await processOneSku(sku);   // 干活（含点击「继续」）
```

**在这个窗口里断电 / 强杀 / 直接关机**，这条 SKU 磁盘上就彻底消失了——既不在 pending、
也不在 done，对账时报「源表中从未进队列的 SKU」。而它**可能已经在 Amazon 那边提交成功**，
于是下次按源表重新入队时会**再提交一次 → 真·重复提交**。

v1.3.3 起的防护：

1. `saveState()` 落盘 `inProgress` + `submitClicks`。
2. `loadState()` 发现残留 `inProgress` 且该 SKU 不在任何列表 → 计入 `failed`
   （原因「进程中断：…结果未知…」），**禁止自动重提**，出表后落在「异常明细」页。
3. 点「继续」前先写 `IN_FLIGHT` 审计行，杀在点击后也能在 `submissions.csv` 里留下痕迹。

> ⚠️ **停机务必走 `POST /api/pause`**，等日志出现「⏸」再关——那样当前这条会走完并落盘。
> 直接关机 / `kill -9` 就是踩上面那个窗口。宁可多等 40 秒。

> ℹ️ 顺带一提：**跑批途中做对账**，正在处理的那条会因"已出队未入 done"而少 1 条。
> v1.3.3 起 `export_report.py` 会把它认作「在途」计入闭合，停止原因显示「仍在运行中」。

## 跑批看门狗（长批次必挂）

控制台自带的熔断**只认基础设施类失败**：

```js
const INFRA_FAIL_RE = /结构|网络|targetId|exec|步数超限|连续/;
```

而额度用尽返回的「亚马逊判定该 FNSKU 不符合重新测量资格」被归类为**业务失败**，
**不会触发熔断**。后果：额度真耗尽时，它会一条条把整批（可能上百条）全部跑成失败再收工，
白白耗掉一两个小时。`watch_run.py` 就是补这个缺口的外挂守护进程。

```bash
python3 watch_run.py --interval 90 --max-not-eligible 3 --stall-minutes 15 \
  --out /tmp/watch.log
```

三重守卫：

| 守卫 | 触发条件 | 动作 |
|---|---|---|
| 额度守卫（核心） | 连续 3 条「不符合重新测量资格」 | 自动 `POST /api/pause` 并退出 |
| 基础设施守卫（兜底） | 连续 5 条基础设施类失败 | 自动暂停 |
| 停滞守卫 | 15 分钟无任何状态变化 | 只告警，不暂停 |

每次打点还会输出**速率与 ETA**（北京时区）以及**紫鸟 Bridge 健康度**：

```
[09-15 09:28:55] 📊 pending=81 | 本批新增成功=1 | 本批新增失败=0 | 当前: X004RR7L0P
[09-15 09:28:55] ⏱ 速率 60s/条 | 预计剩余 82 分钟 | 完成约 09-15 10:50（北京）
```

> ⚠️ **Bridge 健康度必须单独探**（`--bridge-url`，默认 `http://127.0.0.1:9481/health`）。
> Bridge 在负载下会「**端口仍在监听但服务假死**」，CLI 报「无法连接紫鸟浏览器 Bridge」——
> 这是跑批变慢、`步数超限` 判死的**先兆**，而控制器状态里完全看不出来。
> 一旦出现「Bridge 响应偏慢」告警，最有效的处置是**重启紫鸟浏览器**，别硬撑。
> 撑着的代价是单条耗时从 ~50s 涨到 ~4 分钟，还会因空转烧步数丢掉 SKU。

> ⚠️ 看门狗**必须用基线法**：启动时记录 `base_fail = len(failed)`，之后只看 `failed[base_fail:]`。
> `state.json` 里混着往批的 failed，直接看数组末尾元素会把**上批失败**当成本批连续失败，
> 在健康批次上误触发暂停（2026-09-14 实际踩过）。

> ⚠️ 起服务必须用**后台任务方式**（工具的 `run_in_background`），
> `nohup node server.js &` 在工具调用结束时会被回收掉。

## 结果对账表导出（跑完/暂停后必做）

技能目录自带 `export_report.py`，把 `state.json` 与源 FNSKU 清单逐条对账，产出四页工作簿：
**汇总 / 已提交成功 / 未提交-待重排 / 异常明细**。

```bash
python3 export_report.py \
  --state  /path/to/fba-controller/state.json \
  --source ~/Desktop/报销单/ZJ1 重测SKU 9.14.xlsx \
  --out    ~/Desktop/报销单/ZJ1 重测SKU 2026-09-14.xlsx \
  --since  2026-09-14
```

`--since`（可选，北京时间日期）用来切分**本轮新提交**与**历史已提交**：
一个 `state.json` 里同时躺着几个批次的记录，「已提交 45 条」分不清哪些是这次干的。
传入后汇总页多出「🚀 本轮新提交」「📦 其中历史已提交」两行，
「已提交成功」页的历史行会被标成 `—` + 「本轮之前，未重复提交」。**跑新批次时建议都带上。**

**源表两种形态都支持，不用改表**（v1.3.1 起）：

| 形态 | 样子 | 脚本行为 |
|---|---|---|
| 单列 | A 列 = FNSKU | 按 A 列读，结果表无款号列 |
| 双列 | A 列 = 款号，B 列 = FNSKU | 自动探测 FNSKU 列 + **带出款号列**，结果表多一列「款号」 |

探测规则：按 `X[A-Z0-9]{9}` 形态在每列统计命中数，取最高的一列为 FNSKU 列，
其左边一列即款号列。要强制指定列用 `--column B`。

> 运营看款号比看 FNSKU 直观得多，**源表带款号就一定要带出来**，别只给一串 FNSKU。

**输出文件命名约定**：`<运营组> 重测SKU <日期>.xlsx`（如 `ZJ1 重测SKU 2026-09-14.xlsx`、
`XH1 重测SKU 2026-09-10.xlsx`），与源表 `ZJ1 重测SKU 9.14.xlsx` 区分开，别覆盖源表。

脚本内置三条防坑校验，**不要绕过**：

1. 只统计源表里存在的 SKU —— `state.json` 会残留上一批次的记录，不过滤就对不上账。
2. 出表前自检「已提交 + 异常 + 待处理 == 源表总数」，**不等就直接报错退出**，
   并打印重复计入的 SKU、从未进队列的 SKU。
3. case ID 缺失时明确标「已提交（编号未采集）」，不留空。

**汇总页的「停止原因」是三态动态判定**，别写死：全部处理完 = 「本次已全部处理完毕」；
还有待处理且无异常 = 「月度额度用尽（推定）」；有异常 = 「存在异常项」。写死会误导用户。

> Agent 提示词：跑批暂停/结束后，**主动导出这张表并交付给用户**，不要只口头汇报数字。

## 安全模型（务必遵守，避免触发 Amazon 封控）

- **绝不自动提交**：脚本最高优先级门是“检测到‘继续’按钮立即停、不点击”。
- **节流**：步骤间按档位等待（下一页后 1.5–4s）；SKU 间随机间隔（5–40s 视档位）；网络错误等 60s 重试（≤3 次）。
- **暂停边界生效**：暂停后当前 SKU 回退队首，下次从它重跑。
- **不读取/回传任何机密**：脚本只返回 `status` + 截断的可见文本，不碰 Cookie/令牌/输入框值。
- **同一店铺短时间内密集提交易被风控**——SKU 间隔不要太短，推荐均衡或保守。

## 已知问题 & 已修复

- **🔴 月度额度用尽被误判成「页面结构不一致」**（最坑的一个）：
  额度用尽时亚马逊返回的终态页既没有"没有资格"文案、也没有任何按钮，旧版只看文案 → 漏判 →
  落到兜底分支报"结构不符"。**已修复**：改读工作流步骤名 `[data-step-attr] → currentStepName`，
  命中 `inform_seller_not_eligible_for_re_measurement` 即判 `NOT_ELIGIBLE`。详见文首排障章节。

- **🔴 上一条 SKU 的终态页被当成当前 SKU 的结论**（曾导致整段 SKU 被误判）：
  旧的就绪判断是"页面有内容就算就绪"，而上一条的终态页同样"有内容"，于是本条一开工就读到上一条的结论。
  **已修复**，三道闸门：
  1. 就绪探测改为必须确认**起始步骤** `obtain_fnsku_for_us_...` 才开工，否则强制 `location.reload()`（≤3 次）；
  2. 终态页必须校验页面上的 `FNSKU 的详细信息：XXXXXXXXXX` 与当前处理的 SKU 一致，
     不一致 → 返回 `STALE_PAGE`，服务端重载重来（≤3 次）；
  3. **数据完整性闸门**：若某 SKU 从未点过"继续"（无 `submitClicks` 记录）却出现成功页，
     判定为残留页，重载重来，**绝不记成"提交成功"**（否则会虚增成功数并串 case 号）。

- **“页面结构与已知 FBA 重测流程不一致”（UNEXPECTED_STATE）误判**：
  紫鸟向导 `spl-workflow → iframe → contentDocument` 渲染有延迟。每个 SKU 导航后若第一次
  `pageExec` 跑太早，页面还没渲染出可识别步骤文字，会命中脚本兜底分支被误判为结构不符。
  **已修复**：① 导航后轮询等待就绪（替代盲等 6s）；② `UNEXPECTED_STATE` 递增退避重试 3 次（5/10/15s），
  第 2 次起重新做就绪探测；③ "页面内容几乎为空"归为可重试等待态。
- **连续误判熔断**：连续 4 条同因**基础设施类**失败自动暂停（业务类如"无库存"不触发，因为那本来就会连续出现）。
- **store open 不返回 targetId**：改为用 `zclaw invoke visit_page` 拿 `data.data.targetId`。
- **page exec 返回被信封包裹**：结果在 `data.data.result` 字符串里，需二次解析。
- **队列数据质量**：复原 SKU 时务必**同时从 `failed` 和 `pending` 去重**，否则同一 SKU 重复计数，
  对账时表现为总数大于源表。`export_report.py` 会帮你抓出来。

## 代码要点（便于排错）

- `server.js`：零依赖 http 服务 + 状态机 + 安全引擎 + REST API（`/api/state`、`/api/add`、`/api/bulk`、
  `/api/start`、`/api/pause`、`/api/clear`、`/api/reset`、`/api/config`、`/api/throttle`、
  `/api/allow-submit`）+ 静态前端。
- `step-template.js`：`__CONFIG__` 占位符由服务端按 SKU 注入，注入页面执行；返回 JSON 状态驱动引擎。
- `export_report.py`：结果对账表导出（依赖 `openpyxl`）。
- 引擎状态机：`FNSKU_FILLED → NEXT_CLICKED → OPTION_SELECTED → OWN_DATA_NO_SELECTED →
  NEED_REASON/NEED_PACKAGE_TYPE → CONTINUE_CLICKED（仅解封后） → ALREADY_SUBMITTED`。
- 终态/异常态一览：
  | 状态 | 含义 | 处理 |
  |---|---|---|
  | `ALREADY_SUBMITTED` | 页面显示"已创建问题" → 成功 | 记 case ID，完成 |
  | `NOT_ELIGIBLE` | 步骤名=不符合重测资格（**多为额度用尽**） | 记失败，留档页面尺寸/重量 |
  | `NO_INVENTORY` | 无可测量库存（待补货） | 记失败，零重试 |
  | `STALE_PAGE` | 页面残留上一条的结果 | 强制重载重来（≤3 次） |
  | `UNEXPECTED_STATE` | 结构未识别 | 递增退避重试 3 次 |
  | `TECHNICAL_ERROR` | 网络/错误页 | 等 30–60s 重试（≤3 次） |
  | `STOP_BEFORE_CONTINUE` | 停在"继续"前（未解封） | 硬停，等人工 |

## 换店铺 / 复用

不用改代码：设置环境变量 `ZINIAO_STORE_ID` / `ZINIAO_STORE_NAME`（可选 `ZINIAO_CLI` /
`ZINIAO_FBA_URL` / `ZINIAO_FBA_PORT`）后 `node server.js` 即可。公开版本不提供店铺默认值。
