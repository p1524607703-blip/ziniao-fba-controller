# ziniao-fba-controller

本地 Web 控制台，安全驱动「紫鸟 CLI → Amazon Seller Central FBA 重测（remeasure）」的批量自动化。

## 核心特性

- 在**紫鸟浏览器内**逐 SKU 推进 FBA 尺寸/重量重测流程
- **默认硬停在“继续”按钮前**；用户显式解封后才会自动提交（回读到 case ID 才算成功）
- 采集亚马逊**问题编号（case ID）**并落盘 `submissions.csv` 审计日志
- 识别**月度额度用尽**（亚马逊每月上限 120 条，用尽后返回无按钮终态页）
- 陈旧残留页防护：避免把上一条 SKU 的结果当成当前 SKU 的结论
- 准备/完成双列表 + 开始/暂停开关 + 调速档位（防封控）
- `export_report.py` 导出结果对账表（与源清单逐条对账，数字不闭合会报错；自动识别款号列、区分本轮/历史）
- 零依赖 Node 服务，不依赖任何 Agent / MCP
- 店铺信息只通过环境变量配置，仓库不包含任何真实店铺标识

## 快速开始

```bash
# 前置：紫鸟浏览器已登录目标店铺、ziniao-cli 已授权、Node 16+
export ZINIAO_STORE_ID=你的店铺storeId
export ZINIAO_STORE_NAME=你的店铺名
node server.js
# 浏览器打开 http://127.0.0.1:8787/
```

完整文档（前置条件、安全模型、状态机、排错）见 [SKILL.md](./SKILL.md)。

## 目录文件

| 文件 | 作用 |
|------|------|
| `server.js` | 零依赖 http 服务 + 状态机 + 安全引擎 + REST API |
| `step-template.js` | 注入页面的单步执行脚本（`__CONFIG__` 由服务端按 SKU 注入） |
| `start.sh` | 一键后台启动（含“已在运行则不重复起”判断） |
| `export_report.py` | 结果对账表导出（需 `openpyxl`） |
| `public/index.html` | 控制面板前端 |
| `SKILL.md` | WorkBuddy 技能说明与完整文档 |
| `CHANGELOG.md` | 更新日志 |

### 导出对账表

```bash
python3 export_report.py \
  --state  /path/to/fba-controller/state.json \
  --source ~/Desktop/报销单/ZJ1 重测SKU 9.14.xlsx \
  --out    ~/Desktop/报销单/ZJ1 重测SKU 2026-09-14.xlsx \
  --since  2026-09-14
```

产出四页工作簿：**汇总 / 已提交成功 / 未提交-待重排 / 异常明细**。
源表支持单列（A 列 FNSKU）或双列（A 列款号 + B 列 FNSKU，自动识别并带出款号列）。
`--since` 用于区分「本轮新提交」与「历史已提交」——同一份 `state.json` 里会残留往批记录。
内置对账自检：已提交 + 异常 + 待处理 ≠ 源表总数时直接报错退出。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ZINIAO_CLI` | `ziniao-cli` | ziniao-cli 命令或绝对路径 |
| `ZINIAO_STORE_ID` | 无，必填 | 目标店铺 storeId |
| `ZINIAO_STORE_NAME` | 无，必填 | 目标店铺名（`store open --name` 用） |
| `ZINIAO_FBA_URL` | Amazon FBA 重测页 | 重测流程入口 URL |
| `ZINIAO_FBA_PORT` | `8787` | 本地控制台端口 |
| `ZINIAO_ALLOW_SUBMIT` | `0` | 设为 `1` 才允许自动点击“继续”提交；也可运行时 `POST /api/allow-submit {"allow":true}`，**重启后自动复位为关闭** |
| `ZINIAO_NODE` | 自动探测 PATH | 仅 `start.sh` 使用，指定 node 可执行文件 |

## 隐私与网络边界

- 服务只监听 `127.0.0.1`，并校验本机 Host/Origin。
- 队列保存在已被 Git 忽略的 `state.json`，文件权限设为仅当前用户可读写。
- 不要把店铺名称、storeId、FNSKU、Cookie、令牌或代理地址提交到仓库。
- 不要照搬 `DIRECT`/代理规则。应确认紫鸟浏览器实际出口仍是该店铺配置的预期代理；错误的直连规则可能暴露本机公网出口。

## 平台支持（Windows / macOS / Linux）

紫鸟 CLI（`@ziniao-open/cli`）是 **npm 包，原生跨平台**，Windows 同样可用——并非只有 macOS / Linux 版本。新 Agent 请勿因 `os` 字段或本文档示例而误判「Windows 不支持」。

- **macOS / Linux**：`which ziniao-cli` 或 `npm i -g @ziniao-open/cli`；直接 `node server.js` 或 `bash start.sh`。
- **Windows**：
  - 安装 CLI：`npm i -g @ziniao-open/cli`（会生成 `ziniao-cli.cmd` 启动器）。
  - 启动控制台：在仓库目录执行 `node server.js`；若想用 `start.sh`，请在 **Git Bash** 或 **WSL** 中运行（Windows 原生 cmd / PowerShell 不识别 bash 脚本）。
  - 若进程启动后报「找不到 ziniao-cli」类错误，请显式设置环境变量 `ZINIAO_CLI=ziniao-cli.cmd` 再启动（脚本在 Windows 上默认也会尝试 `ziniao-cli.cmd`）。
- 三平台共用同一套环境变量（`ZINIAO_STORE_ID` / `ZINIAO_STORE_NAME` / `ZINIAO_CLI` / `ZINIAO_FBA_URL` / `ZINIAO_FBA_PORT`），换平台无需改代码。

## 免责声明

仅供在已授权的店铺内、人工监督下使用。请遵守 Amazon 与紫鸟的使用条款，控制提交频率以避免风控。
