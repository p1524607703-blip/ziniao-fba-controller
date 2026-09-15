'use strict';
/*
 * 紫鸟 FBA 重测 — 本地控制台
 * 零依赖 Node 服务：状态机 + 安全引擎(到"继续"前硬停) + REST API + 静态前端
 *
 * 安全约束（来自 ziniao-amazon-fba-remeasure 技能）：
 *  - 每个 SKU 单步推进，到"继续"按钮前硬停，绝不点击提交
 *  - SKU 间随机等 20–40s 防突发；网络错误等 60s 再重试(最多3次)
 *  - 暂停键在每一步边界生效；暂停后当前 SKU 回退到准备列表队首
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 店铺/CLI 通过环境变量配置，便于不同店铺与环境复用本脚本。
// 公开版本不内置任何真实店铺标识——店铺名与 storeId 必须显式提供，缺失直接拒绝启动。
// 紫鸟 CLI 是 npm 包 @ziniao-open/cli，原生跨平台。Windows 上 npm 全局安装生成 ziniao-cli.cmd 启动器
const CLI = process.env.ZINIAO_CLI || (process.platform === 'win32' ? 'ziniao-cli.cmd' : 'ziniao-cli');
const STORE_ID = (process.env.ZINIAO_STORE_ID || '').trim();
const STORE_NAME = (process.env.ZINIAO_STORE_NAME || '').trim();

if (!STORE_ID || !STORE_NAME) {
  console.error('✗ 缺少店铺配置：请设置 ZINIAO_STORE_ID 与 ZINIAO_STORE_NAME 后重新启动。');
  console.error('  示例: ZINIAO_STORE_ID=你的storeId ZINIAO_STORE_NAME="你的店铺名" node server.js');
  process.exit(1);
}
const FBA_URL = process.env.ZINIAO_FBA_URL || 'https://sellercentral.amazon.com/help/hub/solution/WF_FBAWeightAndDimensionIssues';
const PORT = Number(process.env.ZINIAO_FBA_PORT || 8787);
const STATE_FILE = path.join(__dirname, 'state.json');
// 解封开关：默认 false（硬停于"继续"前，绝不自动提交）。用户显式解封后才允许自动点击。
let ALLOW_SUBMIT = /^(1|true|yes)$/i.test(String(process.env.ZINIAO_ALLOW_SUBMIT || ''));
const SUBMIT_CLICK_WINDOW = 120000; // 同一 SKU 点击"继续"后的防重复窗口(ms)
const AUDIT_FILE = path.join(__dirname, 'submissions.csv');

// ---- 注入页面的单步脚本模板（CONFIG 由服务端按 SKU 注入）----
const STEP_TEMPLATE = fs.readFileSync(path.join(__dirname, 'step-template.js'), 'utf8');

// ---- 内存状态 ----
const defaultConfig = {
  issueText: '重新测量和赔偿亚马逊物流配送费用',
  reasonText: '尽管我的包装没有变化，亚马逊的商品测量值却不正确了',
  packageText: '塑料袋（聚乙烯塑料袋和铝箔袋等）'
};

// ---- 节流档位（控制台页面可调）----
// step: 各步骤推进后的等待(ms)；skuGap: SKU 间随机间隔(ms)；retryWait: 网络错误重试等待(ms)
const THROTTLE_PRESETS = {
  conservative: { label: '保守', step: { filled: 1500, option: 1500, next: 4000, own: 4000, default: 2500 }, skuGapMin: 20000, skuGapMax: 40000, retryWait: 60000 },
  balanced:     { label: '均衡', step: { filled: 1000, option: 1000, next: 2500, own: 2500, default: 2000 }, skuGapMin: 10000, skuGapMax: 20000, retryWait: 45000 },
  aggressive:   { label: '激进', step: { filled: 800,  option: 800,  next: 1500, own: 1500, default: 1200 }, skuGapMin: 5000,  skuGapMax: 10000, retryWait: 30000 }
};

function getThrottle() {
  const sel = state.throttle || { preset: 'conservative' };
  const base = THROTTLE_PRESETS[sel.preset] || THROTTLE_PRESETS.conservative;
  const skuGapMin = sel.customGapMin != null ? sel.customGapMin : base.skuGapMin;
  const skuGapMax = sel.customGapMax != null ? sel.customGapMax : base.skuGapMax;
  return { preset: sel.preset, step: base.step, skuGapMin, skuGapMax, retryWait: base.retryWait, label: base.label };
}

function throttleEstimate() {
  const t = getThrottle();
  const s = t.step;
  // 单 SKU 约 11 步(CLI往返~1.8s + 节流)，不含取 targetId
  const perStep = 1800 + (s.filled + s.option * 3 + s.next * 4 + s.own) / 11;
  const steps = 11 * perStep + 5000;
  const gap = (t.skuGapMin + t.skuGapMax) / 2;
  return { perSkuSec: Math.round(steps / 1000), gapSec: Math.round(gap / 1000) };
}

let state = {
  status: 'idle',            // idle | running | paused
  inProgress: null,
  pending: [],               // 准备列表 [{sku, ts}]
  done: [],                  // 完成列表(提交就绪) [{sku, dims, ts}]
  failed: [],                // 异常列表 [{sku, reason, ts}]
  config: { ...defaultConfig },
  throttle: { preset: 'conservative', customGapMin: null, customGapMax: null },
  lastTargetId: null,
  submitClicks: {},        // 防重复提交：sku -> 点击"继续"的时间戳
  preSubmitDims: {},       // 审计：sku -> 点击"继续"前页面上的尺寸/重量（提交后页面会跳走，须提前留档）
  log: []
};

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state.pending = raw.pending || [];
    state.done = raw.done || [];
    state.failed = raw.failed || [];
    state.config = { ...defaultConfig, ...(raw.config || {}) };
    state.throttle = { preset: 'conservative', customGapMin: null, customGapMax: null, ...(raw.throttle || {}) };
    state.status = 'idle'; state.inProgress = null; state.lastTargetId = null;
    state.submitClicks = raw.submitClicks || {};
    state.preSubmitDims = {};

    // ---- 崩溃残留恢复（断电 / 强杀 / 关机）----
    // 若磁盘上留着 inProgress，说明上次是在"已出队、尚未定论"的状态下被打断的。
    // 这一条的最终结果本地无从得知：可能已提交（Amazon 已生成问题编号），也可能没提交。
    // 绝不能静默丢弃（会漏账），也绝不能自动重排（可能重复提交）→ 统一计入 failed 中的
    // "结果未知"类，出表时落在「异常明细」页，交人工去卖家后台核对后再决定。
    const stale = raw.inProgress ? String(raw.inProgress).trim() : '';
    const known = state.done.some(x => x.sku === stale)
               || state.failed.some(x => x.sku === stale)
               || state.pending.some(x => x.sku === stale);
    if (stale && !known) {
      const clicked = !!(raw.submitClicks && raw.submitClicks[stale]);
      state.failed.push({
        sku: stale, ts: Date.now(), clicked,
        reason: clicked
          ? '进程中断：已点击“继续”但未确认结果（可能已提交，须人工核对问题编号）'
          : '进程中断：处理到一半未定论（多半未提交，核对后可重提）'
      });
      pushLog(`⚠️ 检测到上次中断残留 SKU ${stale}（${clicked ? '已点过继续' : '未点过继续'}）：`
        + '已计入「异常」并禁止自动重提，请先在卖家后台核对该 FNSKU 是否已生成问题编号');
    }

    pushLog('已加载本地队列：准备 ' + state.pending.length + ' / 完成 ' + state.done.length + ' / 异常 ' + state.failed.length);
  } catch (e) { /* 无文件则使用默认空状态 */ }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      pending: state.pending, done: state.done, failed: state.failed,
      config: state.config, throttle: state.throttle,
      // ⚠️ 必须落盘：inProgress 记录"当前正在处理哪一条"。
      // 处理流程是「先出队 → 再处理 → 成功后入 done」，中间若断电/强杀，
      // 这条就既不在 pending 也不在 done，磁盘上彻底消失（Amazon 那边却可能已生成问题编号）。
      // 配合 loadState() 的残留恢复逻辑，把这种"结果未知"的条目捞出来，禁止静默重提。
      inProgress: state.inProgress,
      // 点过"继续"的时间戳也落盘：崩溃重启后仍能知道"这一条到底点没点过提交"
      submitClicks: state.submitClicks
    }, null, 2));
  } catch (e) {}
}
function pushLog(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  state.log.unshift(`[${t}] ${msg}`);
  if (state.log.length > 200) state.log.length = 200;
}

// 该 SKU 是否刚点过"继续"（窗口内禁止重复点击）
function recentSubmitClick(sku) {
  const t = state.submitClicks[sku];
  return t ? (Date.now() - t < SUBMIT_CLICK_WINDOW) : false;
}

// 提交审计日志：每个 SKU 的提交/停驻都留痕，便于事后核对与申诉
function auditLog(row) {
  try {
    if (!fs.existsSync(AUDIT_FILE)) {
      fs.writeFileSync(AUDIT_FILE, 'time,sku,size,weight,eligible,result,note\n', 'utf8');
    }
    const line = [row.time, row.sku, row.size, row.weight, row.eligible, row.result, row.note]
      .map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(',') + '\n';
    fs.appendFileSync(AUDIT_FILE, line, 'utf8');
  } catch (e) {}
}

// ---- 工具 ----
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomBetween = (a, b) => Math.floor(a + Math.random() * (b - a));

function runCli(args, timeout = 60000) {
  return new Promise(resolve => {
    let out = '', err = '';
    // Windows 下需 shell 才能解析 .cmd 启动器；macOS/Linux 保持原行为
    const cp = spawn(CLI, args, { timeout, shell: process.platform === 'win32' });
    cp.stdout.on('data', d => out += d);
    cp.stderr.on('data', d => err += d);
    cp.on('close', code => resolve({ code, out, err }));
    cp.on('error', e => resolve({ code: -1, out, err: String(e) }));
  });
}

function extractTargetId(s) {
  const m = s.match(/"targetId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

function parseExecResult(s) {
  try {
    const o = JSON.parse(s);
    // 新版 CLI 信封结构: {ok, data:{data:{result:"{...}", targetId, exceptionDetails}}}
    const inner = o?.data?.data?.result;
    if (typeof inner === 'string') {
      const r = JSON.parse(inner);
      if (r && r.status) return r;
    }
    if (inner && typeof inner === 'object' && inner.status) return inner;
    if (o?.status) return o;
  } catch (e) {}
  return null;
}

function extractDimensions(t) {
  // 中文优先，兼容英文页面
  const mSize = t.match(/包裹尺寸[：:]\s*([^\n]+)/) || t.match(/Package\s*dimensions?\s*[：:]?\s*([^\n]+)/i);
  const mWeight = t.match(/包裹重量[：:]\s*([^\n]+)/) || t.match(/(?:Package|Item)\s*weight\s*[：:]?\s*([^\n]+)/i);
  const size = (mSize || [])[1]?.trim() || '';
  const weight = (mWeight || [])[1]?.trim() || '';
  const eligible = /您有资格提交/.test(t) ? '有资格'
    : (/没有资格|不符合条件/.test(t) ? '无资格' : '未知');
  return { size, weight, eligible };
}

// 提交成功页会给出亚马逊问题编号(case id)，如"已创建问题 21984441071"，用于报销/追踪对账
function extractCaseId(t) {
  const m = t.match(/已创建问题\s*(\d{6,})/) || t.match(/(?:case|问题)\s*(?:id|编号)?\s*[:#]?\s*(\d{6,})/i);
  return m ? m[1] : '';
}

async function resolveTarget() {
  // 先确保店铺浏览器已启动（输出不含 targetId，可忽略）
  await runCli(['store', 'open', '--name', STORE_NAME, '--url', FBA_URL], 60000);
  // 导航到 FBA 重测页，visit_page 会稳定回带当前标签页的 targetId
  const r = await runCli(
    ['zclaw', 'invoke', 'visit_page', '--args', JSON.stringify({ storeId: STORE_ID, url: FBA_URL })],
    60000
  );
  if (r.code !== 0) {
    pushLog('visit_page 失败: ' + r.err.slice(0, 160));
    return null;
  }
  try {
    const o = JSON.parse(r.out);
    const tid = o?.data?.data?.targetId || o?.data?.targetId;
    if (tid) { state.lastTargetId = tid; return tid; }
  } catch (e) {}
  pushLog('visit_page 未返回 targetId，原始输出: ' + r.out.slice(0, 160));
  return null;
}

async function pageExec(targetId, script) {
  const r = await runCli(
    ['page', 'exec', '--store-id', STORE_ID, '--target-id', targetId, '--script', script, '--timeout', '55000'],
    60000
  );
  if (r.code !== 0) {
    pushLog('page exec 失败: ' + r.err.slice(0, 160));
    return null;
  }
  return parseExecResult(r.out);
}

// 就绪探测：轮询等待 FBA 向导 iframe 真正渲染完成。
// 盲等固定秒数在冷启动/慢渲染(如长时间空闲后首次运行)时会把"还没渲染好"误判成"结构不符"，
// 从而把整批 SKU 打成失败。这里改成"探测到就绪才走"，既更快(就绪即走)也更稳。
// 探测内容必须足以判断"是不是干净起点"：仅"有内容"不够——
// 上一条 SKU 的终态页(成功/不符合资格)同样"有内容"，会被误当成就绪，
// 于是本条的判定直接读到上一条的终态，把正常 SKU 错报成"不符合资格"。
const READY_PROBE = `(() => {
  try {
    const host = document.querySelector("spl-workflow");
    const frame = host && host.shadowRoot && host.shadowRoot.querySelector("iframe");
    const doc = frame && frame.contentDocument;
    if (!doc || !doc.body) return JSON.stringify({status:"NOT_READY", why:"iframe未加载"});
    const t = String(doc.body.innerText || "").trim();
    if (t.length < 20) return JSON.stringify({status:"NOT_READY", why:"内容为空"});
    let stepName = "";
    try {
      const el = doc.querySelector("[data-step-attr]");
      stepName = JSON.parse((el && el.getAttribute("data-step-attr")) || "{}").currentStepName || "";
    } catch (e) {}
    const inp = doc.querySelector("#item_input");
    return JSON.stringify({ status:"OK", stepName, hasInput: !!inp, inputVal: inp ? String(inp.value || "") : "" });
  } catch (e) { return JSON.stringify({status:"NOT_READY", why:String(e).slice(0,80)}); }
})()`;

// 起始步骤名（表单要求输入 FNSKU）
const INITIAL_STEP_RE = /obtain_fnsku/i;

// 强制重载当前页，用于把"上一条 SKU 遗留的终态"刷回干净起点
async function reloadPage(targetId) {
  await pageExec(targetId, 'setTimeout(() => location.reload(), 0); "reloading"');
}

async function waitWorkflowReady(targetId, sku, maxMs = 90000) {
  const started = Date.now();
  let tries = 0;
  let reloads = 0;
  while (Date.now() - started < maxMs) {
    if (state.pauseRequested) return false;
    const res = await pageExec(targetId, READY_PROBE);
    tries++;
    if (res && res.status === 'OK') {
      if (INITIAL_STEP_RE.test(res.stepName || '')) {
        pushLog(`✓ ${sku} 向导就绪(起始步骤, ${Math.round((Date.now() - started) / 1000)}s / 探测${tries}次)`);
        return true;
      }
      // 停在终态/中间步骤 → 浏览器未拿到干净起点，强制重载再来
      if (reloads < 3) {
        reloads++;
        pushLog(`↻ ${sku} 页面停留在非起始步骤(${(res.stepName || '未知').slice(0, 46)})，强制重载(${reloads}/3)…`);
        await reloadPage(targetId);
        await sleepWithPause(6000);
        continue;
      }
    }
    await sleepWithPause(2500);
  }
  pushLog(`⚠️ ${sku} 等待向导就绪超时(${Math.round(maxMs / 1000)}s)`);
  return false;
}

// ---- 单 SKU 引擎 ----
async function processOneSku(sku) {
  const config = {
    sku,
    issueText: state.config.issueText,
    ownDataAnswer: '否',
    reasonText: state.config.reasonText,
    packageText: state.config.packageText
  };

  let targetId = await resolveTarget();
  if (!targetId) { markFailed(sku, '无法解析店铺标签页 targetId（紫鸟浏览器可能未就绪）'); return 'failed'; }

  // 导航后主动探测向导是否渲染完成（替代原先盲等 6s：慢渲染时不够，快渲染时又浪费）
  pushLog(`⏳ ${sku} 等待向导渲染…`);
  await waitWorkflowReady(targetId, sku, 60000);
  if (state.pauseRequested) { state.status = 'paused'; return 'paused'; }

  let techRetries = 0;
  let structRetries = 0;
  let staleReloads = 0;
  let inner = 0;

  while (inner < 80) {
    if (state.pauseRequested) { state.status = 'paused'; pushLog(`⏸ 已暂停于 ${sku}（步骤 ${inner}）`); return 'paused'; }

    // 每轮刷新解封开关：暂停中、或该 SKU 刚点过"继续"，绝不再点击
    config.allowSubmit = ALLOW_SUBMIT && !state.pauseRequested && !recentSubmitClick(sku);
    const script = STEP_TEMPLATE.replace('__CONFIG__', JSON.stringify(config));
    const res = await pageExec(targetId, script);

    if (!res) {
      // 执行失败 → 视为网络/技术错误，重试
      techRetries++;
      if (techRetries <= 3) { pushLog(`${sku} 执行异常，等 ${Math.round(getThrottle().retryWait/1000)}s 重试(${techRetries}/3)`); await sleepWithPause(getThrottle().retryWait); continue; }
      markFailed(sku, 'page exec 连续失败'); return 'failed';
    }

    const st = res.status;

    // 全流程留档：任一步骤页面出现过尺寸/重量就更新审计留档（提交成功后页面会跳走，读不到）
    if (res.visibleText && /包裹尺寸|包裹重量|package dimension|package weight|item weight/i.test(res.visibleText)) {
      const d = extractDimensions(res.visibleText);
      if (d.size || d.weight) state.preSubmitDims[sku] = d;
    }

    if (st === 'CONTINUE_CLICKED') {
      // 已解封并点击“继续”：登记防重，等待页面响应后回读确认（绝不“点了就算成功”）
      state.submitClicks[sku] = Date.now();
      // 提交后页面会跳走，先把点击前的尺寸/重量留档，供审计使用
      state.preSubmitDims[sku] = extractDimensions(res.visibleText || '');
      // 先写一条 IN_FLIGHT 审计行再点：万一点完之后进程被杀（断电/强关），
      // 审计 CSV 里至少留得下"这条点过提交"的痕迹，供事后核对 Amazon 侧是否真的生成了问题编号。
      auditLog({
        time: new Date().toISOString(), sku, ...state.preSubmitDims[sku],
        result: 'IN_FLIGHT',
        note: '已点击继续，等待回读确认（若此行之后没有对应的 SUBMITTED / CLICKED_NOT_CONFIRMED 行，说明进程被中断，须人工核对是否已生成问题编号）'
      });
      saveState();   // 把「已点击」这件事立刻落盘，别等循环末尾
      pushLog(`🚀 ${sku} 已自动点击“继续”，快速回读确认…`);
      await sleepWithPause(1800);
      inner++;
      continue;
    }
    if (st === 'STOP_BEFORE_CONTINUE') {
      const dims = extractDimensions(res.visibleText || '');
      // 已点击过但页面仍停在“继续”前 → 可能未跳转成功，窗口期内继续等待确认
      if (state.submitClicks[sku] && Date.now() - state.submitClicks[sku] < SUBMIT_CLICK_WINDOW) {
        pushLog(`⏳ ${sku} 已点击“继续”，页面尚未跳转，继续等待确认…`);
        await sleepWithPause(1800);
        inner++;
        continue;
      }
      const clicked = !!state.submitClicks[sku];
      state.done.push({ sku, dims, ts: Date.now(), submitted: clicked, note: clicked ? '已点击继续但未确认到成功提示' : '未解封，停在继续前' });
      auditLog({ time: new Date().toISOString(), sku, ...dims, result: clicked ? 'CLICKED_NOT_CONFIRMED' : 'NOT_SUBMITTED', note: clicked ? '已点击继续但未确认成功，需人工核对' : '停于继续前，未提交' });
      pushLog(`${clicked ? '⚠️' : '⏸'} ${sku} ${clicked ? '已点击继续但未确认成功，请人工核对' : '停于“继续”前(未解封)'}: ${dims.size} / ${dims.weight} / ${dims.eligible}`);
      return 'done';
    }
    if (st === 'ALREADY_SUBMITTED') {
      // 数据完整性闸门：本 SKU 从未点过"继续"，却看到成功页 →
      // 极可能是上一条 SKU 遗留的页面，绝不能记成本条"提交成功"（会虚增成功数并串号）。
      if (!state.submitClicks[sku]) {
        staleReloads++;
        if (staleReloads <= 3) {
          pushLog(`↻ ${sku} 出现成功页但本 SKU 从未点击"继续"，判定为页面残留，强制重载(${staleReloads}/3)`);
          await reloadPage(targetId);
          await sleepWithPause(6000);
          await waitWorkflowReady(targetId, sku, 45000);
          continue;
        }
        markFailed(sku, '页面反复显示非本条的结果，无法确认本条是否已提交（需人工核对）');
        return 'failed';
      }
      // 优先用点击"继续"前留档的尺寸/重量（提交后页面已跳走，读不到）
      const dims = state.preSubmitDims[sku] || extractDimensions(res.visibleText || '');
      const caseId = extractCaseId(res.visibleText || '');
      const note = caseId ? `已创建问题 ${caseId}` : '页面显示已创建问题';
      state.done.push({ sku, dims, ts: Date.now(), submitted: true, caseId, note });
      auditLog({ time: new Date().toISOString(), sku, ...dims, result: 'SUBMITTED', note });
      pushLog(`✅ ${sku} 提交成功${caseId ? '，问题编号 ' + caseId : '（页面显示已创建问题）'}`);
      return 'done';
    }
    if (st === 'NO_INVENTORY') { markFailed(sku, '无可测量库存(库存低/留作配送/转运中)，待补货后才能重测'); return 'failed'; }
    if (st === 'NOT_ELIGIBLE') {
      // 终态页虽无按钮，但会展示该 FNSKU 的当前包裹尺寸/重量，一并留档便于核对
      const dims = extractDimensions(res.visibleText || '');
      markFailed(sku, res.message || '该 SKU 无重测资格', { dims, step: res.step || '' });
      if (dims.size || dims.weight) {
        pushLog(`   ↳ 页面展示的当前尺寸: ${dims.size || '—'} / ${dims.weight || '—'}`);
      }
      return 'failed';
    }
    if (st === 'INVALID_FNSKU') { markFailed(sku, 'FNSKU 格式非法'); return 'failed'; }
    if (st === 'OPTION_NOT_FOUND') { markFailed(sku, `选项未找到: ${res.wanted || ''}`); return 'failed'; }
    if (st === 'NEED_REASON' || st === 'NEED_PACKAGE_TYPE') { markFailed(sku, `缺配置: ${st}`); return 'failed'; }
    if (st === 'NEED_OWN_DATA_DECISION') { markFailed(sku, '需人工决定是否填自有数据'); return 'failed'; }
    if (st === 'STALE_PAGE') {
      // 页面仍是上一条 SKU 的残留 → 不是本条的结论。重载拿干净起点后重来。
      staleReloads++;
      if (staleReloads <= 3) {
        pushLog(`↻ ${sku} ${res.message || '页面残留'}，强制重载重试(${staleReloads}/3)`);
        await reloadPage(targetId);
        await sleepWithPause(6000);
        await waitWorkflowReady(targetId, sku, 45000);
        continue;
      }
      markFailed(sku, '页面反复残留上一条结果，无法拿到干净起点'); return 'failed';
    }
    if (st === 'UNEXPECTED_STATE') {
      // 多为导航后向导未渲染完的竞态。递增退避重试 3 次，并在第 2 次起重新做就绪探测，
      // 避免在一个"根本没渲染出来"的页面上空转到失败。
      structRetries++;
      const waits = [5000, 10000, 15000];
      if (structRetries <= 3) {
        const w = waits[structRetries - 1];
        pushLog(`${sku} 结构暂未识别(向导可能未渲染完)，等 ${w / 1000}s 重试(${structRetries}/3)`);
        await sleepWithPause(w);
        if (structRetries >= 2) await waitWorkflowReady(targetId, sku, 30000);
        continue;
      }
      markFailed(sku, res.message || '页面结构不符'); return 'failed';
    }
    if (st === 'TECHNICAL_ERROR') {
      techRetries++;
      if (techRetries <= 3) { pushLog(`${sku} 网络错误页，等 ${Math.round(getThrottle().retryWait/1000)}s 重试(${techRetries}/3)`); await sleepWithPause(getThrottle().retryWait); targetId = await resolveTarget() || targetId; continue; }
      markFailed(sku, '多次网络错误'); return 'failed';
    }

    // 非终止态：按当前档位节流等待后继续
    const th = getThrottle();
    const s = th.step;
    let wait = s.default;
    if (st === 'FNSKU_FILLED') wait = s.filled;
    else if (st === 'NEXT_CLICKED') wait = s.next;
    else if (st === 'OPTION_SELECTED') wait = s.option;
    else if (st === 'OWN_DATA_NO_SELECTED') wait = s.own;
    else if (st === 'WAIT_WORKFLOW' || st === 'WAIT_NEXT_ENABLED') wait = s.default;
    await sleep(wait);
    inner++;
  }
  markFailed(sku, '单 SKU 步数超限(疑似卡死)');
  return 'failed';
}

// 分块等待，期间可响应暂停
async function sleepWithPause(ms) {
  let elapsed = 0;
  while (elapsed < ms) {
    if (state.pauseRequested) return;
    await sleep(1000);
    elapsed += 1000;
  }
}

// 熔断：仅对"基础设施类"失败(页面结构/网络/targetId/执行超时)计数。
// 业务类失败(无库存、无资格)本来就会连续出现，不能触发熔断。
const INFRA_FAIL_RE = /结构|网络|targetId|exec|步数超限|连续/;
let consecInfraFail = 0;
let lastInfraReason = '';
const FAIL_BREAKER = 4; // 连续 N 条同因基础设施失败即自动暂停

function markFailed(sku, reason, extra = {}) {
  state.failed.push({ sku, reason, ts: Date.now(), ...extra });
  pushLog(`❌ ${sku} 失败: ${reason}`);

  if (INFRA_FAIL_RE.test(reason || '')) {
    if (reason === lastInfraReason) consecInfraFail++;
    else { consecInfraFail = 1; lastInfraReason = reason; }

    if (consecInfraFail >= FAIL_BREAKER) {
      state.pauseRequested = true;
      pushLog(`🛑 熔断：连续 ${consecInfraFail} 条因同一基础设施原因失败（${reason}），已自动暂停`);
      pushLog('   → 请检查紫鸟浏览器/店铺登录态/页面是否还是 FBA 重测向导，确认后再点继续');
    }
  }
}

function resetInfraBreaker() { consecInfraFail = 0; lastInfraReason = ''; }

// ---- 主循环 ----
let engineRunning = false;

async function engine() {
  if (engineRunning) return;
  engineRunning = true;
  state.pauseRequested = false;
  pushLog('▶ 引擎启动');
  try {
    while (state.pending.length > 0) {
      if (state.pauseRequested) { state.status = 'paused'; pushLog('⏸ 已暂停'); break; }
      const item = state.pending.shift();
      const sku = item.sku;
      state.inProgress = sku;
      state.status = 'running';
      saveState();

      const r = await processOneSku(sku);
      state.inProgress = null;
      if (r === 'done') resetInfraBreaker();

      if (r === 'paused') {
        state.pending.unshift({ sku, ts: Date.now() });
        state.status = 'paused';
        saveState();
        break;
      }
      saveState();

      if (state.pending.length > 0) {
        const th = getThrottle();
        const gap = randomBetween(th.skuGapMin, th.skuGapMax);
        pushLog(`⏱ ${sku} 处理完，等待 ${Math.round(gap / 1000)}s 后下一个(防突发)`);
        await sleepWithPause(gap);
        if (state.pauseRequested) { state.status = 'paused'; pushLog('⏸ 间隙暂停'); break; }
      }
    }
    if (state.status !== 'paused') {
      state.status = 'idle';
      pushLog('✅ 全部 SKU 处理完毕');
    }
  } finally {
    engineRunning = false;
    saveState();
  }
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };

function sendJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (p === '/api/state') {
    sendJSON(res, { ...state, allowSubmit: ALLOW_SUBMIT, throttle: getThrottle(), throttleSelection: state.throttle, presets: THROTTLE_PRESETS, estimate: throttleEstimate() });
    return;
  }

  if (p === '/api/add' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sku } = JSON.parse(body || '{}');
        const s = String(sku || '').trim().toUpperCase();
        if (!/^X[A-Z0-9]{9}$/.test(s)) return sendJSON(res, { ok: false, msg: 'FNSKU 格式应为 X + 9位字母数字' });
        if (state.pending.some(x => x.sku === s) || state.done.some(x => x.sku === s)) {
          return sendJSON(res, { ok: false, msg: '该 SKU 已在列表中' });
        }
        state.pending.push({ sku: s, ts: Date.now() });
        pushLog(`➕ 加入准备列表: ${s}`);
        saveState();
        sendJSON(res, { ok: true });
      } catch (e) { sendJSON(res, { ok: false, msg: '解析失败' }); }
    });
    return;
  }

  if (p === '/api/bulk' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { text } = JSON.parse(body || '{}');
        const found = String(text || '').toUpperCase().match(/X[A-Z0-9]{9}/g) || [];
        const added = [];
        for (const s of found) {
          if (!state.pending.some(x => x.sku === s) && !state.done.some(x => x.sku === s)) {
            state.pending.push({ sku: s, ts: Date.now() });
            added.push(s);
          }
        }
        pushLog(`➕ 批量加入 ${added.length} 个: ${added.join(', ')}`);
        saveState();
        sendJSON(res, { ok: true, added });
      } catch (e) { sendJSON(res, { ok: false, msg: '解析失败' }); }
    });
    return;
  }

  if (p === '/api/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { sku } = JSON.parse(body || '{}');
        state.pending = state.pending.filter(x => x.sku !== sku);
        pushLog(`➖ 移除准备项: ${sku}`);
        saveState();
        sendJSON(res, { ok: true });
      } catch (e) { sendJSON(res, { ok: false }); }
    });
    return;
  }

  if (p === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const c = JSON.parse(body || '{}');
        if (c.issueText) state.config.issueText = c.issueText;
        if (c.reasonText) state.config.reasonText = c.reasonText;
        if (c.packageText) state.config.packageText = c.packageText;
        pushLog('⚙ 更新配置: 原因/包装已保存');
        saveState();
        sendJSON(res, { ok: true });
      } catch (e) { sendJSON(res, { ok: false }); }
    });
    return;
  }

  if (p === '/api/throttle' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const c = JSON.parse(body || '{}');
        if (c.preset && THROTTLE_PRESETS[c.preset]) {
          state.throttle.preset = c.preset;
          pushLog('⚙ 节流档位 → ' + THROTTLE_PRESETS[c.preset].label);
        }
        // 自定义 SKU 间隔（秒，留空/null 用档位默认）
        if (c.gapSec != null && c.gapSec !== '') {
          const g = parseInt(c.gapSec, 10);
          if (!isNaN(g) && g >= 2) { state.throttle.customGapMin = g * 1000; state.throttle.customGapMax = g * 1000; }
        } else if (c.gapSec === '' || c.gapSec === null) {
          state.throttle.customGapMin = null; state.throttle.customGapMax = null;
        }
        if (c.resetCustom) { state.throttle.customGapMin = null; state.throttle.customGapMax = null; }
        saveState();
        sendJSON(res, { ok: true, throttle: getThrottle() });
      } catch (e) { sendJSON(res, { ok: false }); }
    });
    return;
  }

  if (p === '/api/allow-submit' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const c = JSON.parse(body || '{}');
        if (typeof c.allow === 'boolean') {
          ALLOW_SUBMIT = c.allow;
          pushLog(ALLOW_SUBMIT ? '🔓 已解封：允许自动点击"继续"提交' : '🔒 已重新冻结：停在"继续"前，不自动提交');
          saveState();
        }
        sendJSON(res, { ok: true, allowSubmit: ALLOW_SUBMIT });
      } catch (e) { sendJSON(res, { ok: false }); }
    });
    return;
  }

  if (p === '/api/start' && req.method === 'POST') {
    if (state.pending.length === 0) return sendJSON(res, { ok: false, msg: '准备列表为空' });
    state.pauseRequested = false;
    if (!engineRunning) engine();
    else { state.status = 'running'; state.pauseRequested = false; }
    sendJSON(res, { ok: true });
    return;
  }

  if (p === '/api/pause' && req.method === 'POST') {
    state.pauseRequested = true;
    state.status = 'paused';
    pushLog('⏸ 收到暂停指令');
    saveState();
    sendJSON(res, { ok: true });
    return;
  }

  if (p === '/api/clear' && req.method === 'POST') {
    state.done = []; state.failed = [];
    pushLog('🧹 清空完成/异常列表');
    saveState();
    sendJSON(res, { ok: true });
    return;
  }

  if (p === '/api/reset' && req.method === 'POST') {
    state.pauseRequested = true;
    state.pending = []; state.done = []; state.failed = []; state.inProgress = null; state.status = 'idle';
    pushLog('🔄 已重置全部队列');
    saveState();
    sendJSON(res, { ok: true });
    return;
  }

  res.writeHead(404); res.end('not found');
});

loadState();
server.listen(PORT, '127.0.0.1', () => {
  pushLog(`🌐 控制台已启动: http://127.0.0.1:${PORT}`);
  console.log(`FBA remeasure controller on http://127.0.0.1:${PORT}`);
});
