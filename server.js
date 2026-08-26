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

// 店铺必须显式配置；公开版本不内置任何真实店铺标识。
// 紫鸟 CLI 是 npm 包 @ziniao-open/cli，原生跨平台。Windows 上 npm 全局安装生成 ziniao-cli.cmd 启动器
const CLI = process.env.ZINIAO_CLI || (process.platform === 'win32' ? 'ziniao-cli.cmd' : 'ziniao-cli');
const STORE_ID = String(process.env.ZINIAO_STORE_ID || '').trim();
const STORE_NAME = String(process.env.ZINIAO_STORE_NAME || '').trim();
const FBA_URL = process.env.ZINIAO_FBA_URL || 'https://sellercentral.amazon.com/help/hub/solution/WF_FBAWeightAndDimensionIssues';
const PORT = Number.parseInt(process.env.ZINIAO_FBA_PORT || '8787', 10);
const STATE_FILE = path.join(__dirname, 'state.json');

if (!/^\d+$/.test(STORE_ID) || !STORE_NAME) {
  console.error('启动失败：请设置有效的 ZINIAO_STORE_ID 和 ZINIAO_STORE_NAME。');
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('启动失败：ZINIAO_FBA_PORT 必须是 1–65535 的端口号。');
  process.exit(1);
}

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
    pushLog('已加载本地队列：准备 ' + state.pending.length + ' / 完成 ' + state.done.length + ' / 异常 ' + state.failed.length);
  } catch (e) { /* 无文件则使用默认空状态 */ }
}
function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        pending: state.pending, done: state.done, failed: state.failed, config: state.config, throttle: state.throttle
      }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    );
    fs.chmodSync(STATE_FILE, 0o600);
  } catch (e) {}
}
function pushLog(msg) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  state.log.unshift(`[${t}] ${msg}`);
  if (state.log.length > 200) state.log.length = 200;
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
  const size = (t.match(/包裹尺寸[：:]\s*([^\n]+)/) || [])[1]?.trim() || '';
  const weight = (t.match(/包裹重量[：:]\s*([^\n]+)/) || [])[1]?.trim() || '';
  const eligible = /您有资格提交/.test(t) ? '有资格'
    : (/没有资格|不符合条件/.test(t) ? '无资格' : '未知');
  return { size, weight, eligible };
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

  // 导航后稍等紫鸟向导 iframe 充分渲染，避免第一步就误判"结构不符"(向导渲染有延迟的竞态)
  pushLog(`⏳ ${sku} 等待向导渲染…`);
  await sleep(6000);

  let techRetries = 0;
  let structRetries = 0;
  let inner = 0;

  while (inner < 80) {
    if (state.pauseRequested) { state.status = 'paused'; pushLog(`⏸ 已暂停于 ${sku}（步骤 ${inner}）`); return 'paused'; }

    const script = STEP_TEMPLATE.replace('__CONFIG__', JSON.stringify(config));
    const res = await pageExec(targetId, script);

    if (!res) {
      // 执行失败 → 视为网络/技术错误，重试
      techRetries++;
      if (techRetries <= 3) { pushLog(`${sku} 执行异常，等 ${Math.round(getThrottle().retryWait/1000)}s 重试(${techRetries}/3)`); await sleepWithPause(getThrottle().retryWait); continue; }
      markFailed(sku, 'page exec 连续失败'); return 'failed';
    }

    const st = res.status;

    if (st === 'STOP_BEFORE_CONTINUE') {
      const dims = extractDimensions(res.visibleText || '');
      state.done.push({ sku, dims, ts: Date.now() });
      pushLog(`✅ ${sku} 已就绪(停于"继续"前): ${dims.size} / ${dims.weight} / ${dims.eligible} — 请在紫鸟浏览器手动点"继续"提交`);
      return 'done';
    }
    if (st === 'ALREADY_SUBMITTED') {
      state.done.push({ sku, dims: extractDimensions(res.visibleText || ''), ts: Date.now(), note: '页面显示已创建问题' });
      pushLog(`✅ ${sku} 似乎已提交(页面提示已创建问题)`);
      return 'done';
    }
    if (st === 'NOT_ELIGIBLE') { markFailed(sku, '该 SKU 无重测资格'); return 'failed'; }
    if (st === 'INVALID_FNSKU') { markFailed(sku, 'FNSKU 格式非法'); return 'failed'; }
    if (st === 'OPTION_NOT_FOUND') { markFailed(sku, `选项未找到: ${res.wanted || ''}`); return 'failed'; }
    if (st === 'NEED_REASON' || st === 'NEED_PACKAGE_TYPE') { markFailed(sku, `缺配置: ${st}`); return 'failed'; }
    if (st === 'NEED_OWN_DATA_DECISION') { markFailed(sku, '需人工决定是否填自有数据'); return 'failed'; }
    if (st === 'UNEXPECTED_STATE') {
      // 多为导航后向导未渲染完的竞态，仅重试 1 次；仍不符才视为真结构问题
      structRetries++;
      if (structRetries <= 1) {
        pushLog(`${sku} 结构暂未识别(向导可能未渲染完)，等 5s 重试(${structRetries}/1)`);
        await sleepWithPause(5000);
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

function markFailed(sku, reason) {
  state.failed.push({ sku, reason, ts: Date.now() });
  pushLog(`❌ ${sku} 失败: ${reason}`);
}

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
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const allowedHosts = new Set([
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    `[::1]:${PORT}`
  ]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`
  ]);
  const host = String(req.headers.host || '').toLowerCase();
  const origin = String(req.headers.origin || '').toLowerCase();
  if (!allowedHosts.has(host) || (origin && !allowedOrigins.has(origin))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }

  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  if (p === '/' || p === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (p === '/api/state' && req.method === 'GET') {
    sendJSON(res, { ...state, throttle: getThrottle(), throttleSelection: state.throttle, presets: THROTTLE_PRESETS, estimate: throttleEstimate() });
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
