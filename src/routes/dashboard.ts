import { Hono } from "hono";

export function createDashboardRoute(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(dashboardHTML()));
  return app;
}

function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM Cache Proxy</title>
<style>
:root {
  --bg: #0a0c10;
  --surface: #12151a;
  --surface2: #1a1e26;
  --border: #2a2e38;
  --text: #e2e4e9;
  --text2: #8b8fa3;
  --accent: #6c8cff;
  --green: #34d399;
  --red: #f87171;
  --purple: #a78bfa;
  --yellow: #fbbf24;
  --radius: 10px;
  --shadow: 0 1px 2px rgba(0,0,0,0.3);
  --green-contrast: var(--green);
}
/* ── 浅色主题：仅当根节点带 data-theme="light" 时生效 ── */
:root[data-theme="light"] {
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface2: #e8ebf0;
  --border: #c8cdd6;
  --text: #1a1d23;
  --text2: #4b5563;
  --accent: #4f6bff;
  --green: #047857;
  --red: #dc2626;
  --purple: #7c3aed;
  --yellow: #d97706;
  --shadow: 0 1px 2px rgba(0,0,0,0.06);
  --green-contrast: #047857; /* 浅色主题下绿色徽章的深色背景 */
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  transition: background-color 0.2s, color 0.2s;
}
.section, .stat-card, .btn, .warmer-select, .theme-toggle, .modal, input, select, textarea {
  transition: background-color 0.2s, border-color 0.2s, color 0.2s;
}
input, select, textarea {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font: inherit;
}
input::placeholder, textarea::placeholder { color: var(--text2); }
input:disabled, select:disabled, textarea:disabled {
  background: var(--surface2);
  color: var(--text2);
  cursor: not-allowed;
  opacity: 0.7;
}
.placeholder-hint { color: var(--text2); font-weight: 400; font-size: 11px; margin-left: 4px; }
:root[data-theme="dark"] { color-scheme: dark; }
:root[data-theme="light"] { color-scheme: light; }

/* ── Header ── */
.header {
  padding: 24px 32px 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.header h1 {
  font-size: 20px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
.header h1 .ver {
  font-size: 11px;
  background: var(--green-contrast, var(--green));
  color: #fff;
  padding: 2px 8px;
  border-radius: 20px;
  font-weight: 700;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.warmer-select {
  padding: 6px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}
.theme-toggle {
  padding: 6px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  line-height: 1;
}
.theme-toggle:hover { background: var(--border); }
.updated { font-size: 12px; color: var(--text2); }

/* ── Container ── */
.container {
  padding: 20px 32px 32px;
  max-width: 1200px;
  margin: 0 auto;
}

/* ── Stats Grid ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}
.stat-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 16px;
  text-align: center;
}
.stat-card .label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text2);
  margin-bottom: 8px;
}
.stat-card .value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
}
.stat-card .hint {
  margin-top: 6px;
  font-size: 10px;
  color: var(--text2);
}
.stat-card .value.blue { color: var(--accent); }
.stat-card .value.green { color: var(--green); }
.stat-card .value.purple { color: var(--purple); }

/* ── Section ── */
.section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.section-header {
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  gap: 8px;
}
.section-header h2 { font-size: 14px; font-weight: 600; }

/* ── Buttons ── */
.btn {
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface2);
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: var(--border); }
.btn-primary { border-color: var(--accent); color: var(--accent); }
.btn-danger { border-color: var(--red); color: var(--red); }
.btn-sm { padding: 4px 10px; font-size: 11px; }

/* ── Upstream Table ── */
.upstream-table { width: 100%; border-collapse: collapse; }
.upstream-table th {
  text-align: left;
  padding: 10px 20px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text2);
  background: var(--surface2);
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.upstream-table td {
  padding: 14px 20px;
  font-size: 13px;
  border-top: 1px solid var(--border);
  vertical-align: top;
}
.upstream-table tr:hover td { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.upstream-name { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.upstream-name .default-mark { color: var(--green); font-size: 12px; }
.upstream-url {
  color: var(--text2);
  font-size: 12px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  background: var(--surface2);
  color: var(--text2);
  margin-right: 4px;
  margin-bottom: 2px;
}
.tag-cache-auto { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--green); }
.tag-cache-active { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
.tag-cache-none { background: color-mix(in srgb, var(--red) 15%, transparent); color: var(--red); }
.tag-warn { background: color-mix(in srgb, var(--yellow) 18%, transparent); color: var(--yellow); }
.tag-danger { background: color-mix(in srgb, var(--red) 16%, transparent); color: var(--red); }
.cache-cliff-row td { background: color-mix(in srgb, var(--red) 8%, transparent); }
.cache-gap { color: var(--text2); font-size: 12px; }
.cache-gap.warn { color: var(--yellow); }
.cache-coverage { font-weight: 600; }
.cell-actions { display: flex; gap: 6px; justify-content: flex-end; }
.empty-state { padding: 40px 20px; text-align: center; color: var(--text2); font-size: 13px; }

/* ── Model list in table ── */
.model-list { display: flex; flex-direction: column; gap: 6px; }
.model-item {
  background: var(--surface2);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
}
.model-item .model-id { font-weight: 600; color: var(--text); margin-bottom: 3px; }
.model-item .model-flags { display: flex; flex-wrap: wrap; gap: 4px; }
.model-item .model-flags .mf {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--border);
  color: var(--text2);
}
.model-item .model-flags .mf.on { background: color-mix(in srgb, var(--green) 15%, transparent); color: var(--green); }
.model-item .model-meta { font-size: 10px; color: var(--text2); margin-top: 3px; }

/* ── Footer actions ── */
.footer-actions { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }

/* ── Modal (wider for model editing) ── */
.modal-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--text) 50%, transparent);
  z-index: 100;
  justify-content: center;
  align-items: flex-start;
  padding-top: 40px;
  overflow-y: auto;
}
.modal-overlay.show { display: flex; }
.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 28px;
  width: 640px;
  max-width: 95vw;
  margin-bottom: 40px;
}
.modal h2 { font-size: 16px; font-weight: 600; color: var(--accent); margin-bottom: 20px; }
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 5px; font-weight: 500; }
.form-group input,
.form-group select {
  width: 100%;
  padding: 9px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 13px;
}
.form-group input:focus,
.form-group select:focus { outline: none; border-color: var(--accent); }
.form-row { display: flex; gap: 12px; }
.form-row > .form-group { flex: 1; }
.checkbox-row { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 14px; }
.checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text2); cursor: pointer; }
.checkbox-label input[type=checkbox] { width: auto; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 22px; }

/* ── Model editor cards ── */
.model-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.model-editor-header h3 { font-size: 13px; font-weight: 600; color: var(--text); }
.model-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 10px;
}
.model-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.model-card-header .model-num { font-size: 12px; color: var(--text2); font-weight: 600; }
.model-card .form-group { margin-bottom: 10px; }
.model-card .form-group:last-child { margin-bottom: 0; }
.model-card .model-meta-details { margin-top: 10px; padding: 10px 12px; border: 1px dashed var(--border); border-radius: 6px; background: var(--bg2, transparent); }
.model-card .model-meta-details summary { cursor: pointer; font-size: 12px; color: var(--text2); user-select: none; }
.model-card .model-meta-details summary:hover { color: var(--text1, inherit); }
.model-card .model-meta-details[open] { padding-bottom: 14px; }
.model-card .model-meta-details[open] summary { margin-bottom: 10px; }
.token-row { display: flex; gap: 10px; }
.token-row > .form-group { flex: 1; }
.token-row input { text-align: right; }

/* ── Responsive ── */
@media (max-width: 900px) {
  .stats-grid { grid-template-columns: repeat(3, 1fr); }
  .container { padding: 16px; }
  .header { padding: 16px 16px 0; }
}
@media (max-width: 600px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .upstream-table th:nth-child(2),
  .upstream-table td:nth-child(2) { display: none; }
  .form-row { flex-direction: column; gap: 0; }
}
</style>
</head>
<body>

<div class="header">
  <h1>LLM Cache Proxy <span class="ver">v2</span></h1>
  <div class="header-right">
    <button class="theme-toggle" id="theme-btn" onclick="toggleTheme()" title="切换主题">🌙</button>
    <select class="warmer-select" id="warmer-sel" onchange="setWarmer()">
      <option value="0">预热: 关闭</option>
      <option value="60">60s</option>
      <option value="120">120s</option>
      <option value="250">250s</option>
      <option value="300">300s</option>
    </select>
    <span class="updated" id="warmer-status"></span>
    <span class="updated" id="upd"></span>
  </div>
</div>

<div class="container">
  <div class="stats-grid">
    <div class="stat-card"><div class="label">输入 Tokens</div><div class="value blue" id="s-input">0</div></div>
    <div class="stat-card" title="厂商返回的缓存命中 tokens"><div class="label">缓存命中 Tokens</div><div class="value green" id="s-cache">0</div></div>
    <div class="stat-card"><div class="label">输出 Tokens</div><div class="value purple" id="s-output">0</div></div>
    <div class="stat-card" title="缓存覆盖率 = 缓存命中 Tokens / 输入 Tokens"><div class="label">缓存覆盖率</div><div class="value green" id="s-rate">0%</div><div class="hint">命中 / 输入</div></div>
    <div class="stat-card"><div class="label">请求次数</div><div class="value" id="s-count">0</div></div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>主动缓存断点</h2>
      <span class="updated" id="cache-upd">—</span>
    </div>
    <div id="cache-points" class="empty-state">暂无主动缓存记录</div>
  </div>

  <div class="section">
    <div class="section-header">
      <h2>上游配置</h2>
      <button class="btn btn-primary" onclick="openAdd()">+ 新增上游</button>
    </div>
    <div id="ulist"></div>
  </div>

  <div class="footer-actions">
    <button class="btn btn-primary" onclick="testCache()">测试缓存</button>
    <button class="btn btn-danger" onclick="clearStats()">清空统计</button>
  </div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="mod">
  <div class="modal">
    <h2 id="m-title">新增上游</h2>
    <input type="hidden" id="f-org">
    <div class="form-group">
      <label>名称</label>
      <input id="f-name" placeholder="my-api">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>API 格式</label>
        <select id="f-format">
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>
      <div class="form-group">
        <label>缓存模式</label>
        <select id="f-cache">
          <option value="active">主动缓存（百炼/Anthropic）</option>
          <option value="implicit">隐式缓存（DeepSeek/智谱/Kimi）</option>
          <option value="none">无缓存</option>
        </select>
      </div>
      <div class="form-group">
        <label title="safe=生产优先，尽量不改语义；aggressive=缓存优先，适合编码智能体">清理强度</label>
        <select id="f-norm">
          <option value="safe">Safe（生产默认）</option>
          <option value="aggressive">Aggressive（缓存优先）</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>API 地址</label>
      <input id="f-url" placeholder="https://api.example.com/v1">
    </div>
    <div class="form-group">
      <label>API Key</label>
      <input id="f-key" placeholder="sk-xxx / \${ENV_VAR}">
    </div>
    <div class="checkbox-row">
      <label class="checkbox-label"><input type="checkbox" id="f-multi"> 上游级多模态</label>
      <label class="checkbox-label" title="Anthropic 兼容端点不识别 cache_control 字段时关闭（如 MiniMax 兼容路径）"><input type="checkbox" id="f-cc"> 支持 cache_control</label>
      <label class="checkbox-label" title="勾选后此上游不参与按 model 自动路由，但仍可在面板中编辑"><input type="checkbox" id="f-disabled"> 禁用此上游</label>
      <label class="checkbox-label" title="数字越小越优先；同优先级按 upstreams.json 写入顺序">优先级
        <input type="number" id="f-priority" value="100" min="0" max="9999" step="1" style="width:80px;margin-left:6px">
      </label>
    </div>

    <!-- Model Editor -->
    <div class="model-editor-header">
      <h3>模型配置</h3>
      <button class="btn btn-sm btn-primary" onclick="addModelCard()">+ 添加模型</button>
    </div>
    <div id="model-cards"></div>

    <div class="modal-actions">
      <button class="btn" onclick="closeMod()">取消</button>
      <button class="btn btn-primary" onclick="save()">保存</button>
    </div>
  </div>
</div>

<script>
var data = { default: '', upstreams: [] };
var editingModels = [];

function E(id) { return document.getElementById(id); }

/* ── 主题切换：localStorage 持久化 + 首次访问跟随系统 ── */
(function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) {}
  var theme = saved === 'light' || saved === 'dark'
    ? saved
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
  // 等到按钮渲染好后更新图标
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  });
})();
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) {}
  var btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = next === 'light' ? '☀️' : '🌙';
}

async function api(u, o) {
  var r = await fetch(u, o);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

function syncConfigOptions() {
  var format = E('f-format').value;
  var cache = E('f-cache').value;
  var cacheOptions = format === 'anthropic'
    ? [{ v: 'active', t: '主动缓存（含 safe/aggressive）' }, { v: 'none', t: '无缓存' }]
    : [{ v: 'implicit', t: '隐式缓存（prefix cache）' }, { v: 'none', t: '无缓存' }];
  var allowed = cacheOptions.map(function(o) { return o.v; });
  if (allowed.indexOf(cache) < 0) cache = cacheOptions[0].v;
  E('f-cache').innerHTML = cacheOptions.map(function(o) {
    return '<option value="' + o.v + '">' + o.t + '</option>';
  }).join('');
  E('f-cache').value = cache;

  var canTuneNormalization = format === 'anthropic' && cache === 'active';
  E('f-norm').disabled = !canTuneNormalization;
  if (!canTuneNormalization) E('f-norm').value = 'safe';

  var canCacheControl = format === 'anthropic' && cache === 'active';
  E('f-cc').disabled = !canCacheControl;
  if (!canCacheControl) E('f-cc').checked = false;
}

async function refresh() {
  try {
    var a = await Promise.all([
      api('/stats'),
      api('/admin/upstreams'),
      api('/admin/warmer').catch(function() { return {}; })
    ]);
    var s = a[0].requests;
    data = a[1];
    var w = a[2];
    E('s-input').textContent = (s.totalPromptTokens || 0).toLocaleString();
    E('s-cache').textContent = (s.totalCacheHitTokens || 0).toLocaleString();
    E('s-output').textContent = (s.totalCompletionTokens || 0).toLocaleString();
    E('s-rate').textContent = s.cacheCoverageRate || s.cacheHitRate || '0%';
    E('s-count').textContent = s.totalRequests || 0;
    if (w) {
      E('warmer-sel').value = w.active ? String(w.interval) : '0';
      var max = w.maxRounds || 0;
      var rounds = w.warmRounds || 0;
      if (w.pausedByMaxRounds) {
        E('warmer-status').textContent = '预热暂停 ' + rounds + '/' + max;
      } else if (w.active && max > 0) {
        E('warmer-status').textContent = '预热 ' + rounds + '/' + max;
      } else if (w.active) {
        E('warmer-status').textContent = '预热 ∞';
      } else {
        E('warmer-status').textContent = '';
      }
    }
    renderCachePoints(a[0].recentCachePoints || []);
    renderUpstreams();
    E('upd').textContent = new Date().toLocaleTimeString('zh-CN');
  } catch (e) {
    E('upd').textContent = e.message;
  }
}

function renderCachePoints(records) {
  var el = E('cache-points');
  if (!records.length) {
    el.className = 'empty-state';
    el.textContent = '暂无主动缓存记录';
    E('cache-upd').textContent = '—';
    return;
  }
  el.className = '';
  var h = '<table class="upstream-table"><thead><tr>';
  h += '<th>时间</th><th>上游</th><th>模型</th><th>断点 (messages 索引)</th><th>跨度</th><th>覆盖率</th><th>命中 token</th><th>未命中 token</th><th>诊断</th>';
  h += '</tr></thead><tbody>';
  records.slice().reverse().forEach(function(r) {
    var t = new Date(r.timestamp).toLocaleTimeString('zh-CN');
    var pts = (r.cachePoints || []).map(function(i) { return '#' + i; }).join(', ');
    var gaps = r.cachePointGaps || [];
    var gapText = gaps.length ? gaps.map(function(g) { return String(g); }).join(' / ') : '—';
    var maxGap = gaps.length ? Math.max.apply(null, gaps) : 0;
    var coverage = typeof r.cacheCoverage === 'number'
      ? (r.cacheCoverage * 100).toFixed(1) + '%'
      : '—';
    var diag = [];
    if (r.cacheCliff) diag.push('<span class="tag tag-danger">断崖</span>');
    if (maxGap > 18) diag.push('<span class="tag tag-warn">跨度&gt;18</span>');
    if (!diag.length) diag.push('<span class="tag tag-cache-active">正常</span>');
    h += '<tr' + (r.cacheCliff ? ' class="cache-cliff-row"' : '') + '>';
    h += '<td>' + t + '</td>';
    h += '<td>' + r.upstream + '</td>';
    h += '<td>' + r.model + '</td>';
    h += '<td><code>' + (pts || '—') + '</code></td>';
    h += '<td><span class="cache-gap' + (maxGap > 18 ? ' warn' : '') + '">' + gapText + '</span></td>';
    h += '<td><span class="cache-coverage">' + coverage + '</span></td>';
    h += '<td>' + (r.vendorCacheHitTokens || 0).toLocaleString() + '</td>';
    h += '<td>' + (r.vendorCacheMissTokens || 0).toLocaleString() + '</td>';
    h += '<td>' + diag.join('') + '</td>';
    h += '</tr>';
  });
  h += '</tbody></table>';
  el.innerHTML = h;
  E('cache-upd').textContent = new Date().toLocaleTimeString('zh-CN');
}

function cacheTagClass(mode) {
  if (mode === 'implicit') return 'tag-cache-auto';
  if (mode === 'active') return 'tag-cache-active';
  return 'tag-cache-none';
}
function cacheLabel(mode) {
  return { implicit: '隐式', active: '主动', none: '无' }[mode] || mode;
}

function renderUpstreams() {
  var el = E('ulist');
  if (!data.upstreams.length) {
    el.innerHTML = '<div class="empty-state">暂无上游配置</div>';
    return;
  }
  var h = '<table class="upstream-table"><thead><tr>';
  h += '<th>名称</th><th>地址</th><th>配置</th><th>模型</th><th style="text-align:right">操作</th>';
  h += '</tr></thead><tbody>';
  data.upstreams.forEach(function(u) {
    var isDef = u.name === data.default;
    h += '<tr>';
    h += '<td><div class="upstream-name">' + u.name + (isDef ? ' <span class="default-mark">✦</span>' : '') + '</div></td>';
    h += '<td><div class="upstream-url" title="' + u.baseURL + '">' + u.baseURL + '</div></td>';
    h += '<td><span class="tag ' + cacheTagClass(u.cacheMode) + '">' + cacheLabel(u.cacheMode) + '</span>';
    h += '<span class="tag ' + (u.normalization === 'aggressive' ? 'tag-warn' : '') + '" title="清理强度">' + (u.normalization === 'aggressive' ? '激进清理' : '安全清理') + '</span>';
    if (u.multimodal) h += '<span class="tag" style="color:var(--accent);background:color-mix(in srgb, var(--accent) 12%, transparent)">多模态</span>';
    if (u.supportsCacheControl === false) h += '<span class="tag" title="此上游 anthropic 兼容端点不识别 cache_control 字段" style="color:#fbbf24;background:color-mix(in srgb, #fbbf24 12%, transparent)">无 cache_control</span>';
    if (u.disabled) h += '<span class="tag tag-danger" title="此上游已禁用，不参与路由">已禁用</span>';
    if (typeof u.priority === "number" && u.priority !== 100) h += '<span class="tag" title="同 model 多上游匹配优先级" style="color:var(--accent);background:color-mix(in srgb, var(--accent) 12%, transparent)">P' + u.priority + '</span>';
    h += '<span class="tag">' + (u.apiFormat || 'openai') + '</span></td>';
    h += '<td><div class="model-list">';
    (u.models || []).forEach(function(m) {
      var id = typeof m === 'string' ? m : m.id;
      h += '<div class="model-item">';
      h += '<div class="model-id">' + id + '</div>';
      h += '<div class="model-flags">';
      if (typeof m === 'object') {
        h += '<span class="mf' + (m.toolCalling ? ' on' : '') + '">工具</span>';
        h += '<span class="mf' + (m.imageInput ? ' on' : '') + '">图片</span>';
        h += '<span class="mf' + (m.thinking ? ' on' : '') + '">思考</span>';
        if (m.allowCloseThinking) h += '<span class="mf on">可关思考</span>';
        if (m.thinkingIntensity && m.thinkingIntensity.length) {
          h += '<span class="mf">' + m.thinkingIntensity.join('/') + '</span>';
        }
      }
      h += '</div>';
      if (typeof m === 'object' && (m.maxInputTokens || m.maxOutputTokens)) {
        h += '<div class="model-meta">';
        if (m.maxInputTokens) h += '输入:' + m.maxInputTokens.toLocaleString();
        if (m.maxInputTokens && m.maxOutputTokens) h += ' / ';
        if (m.maxOutputTokens) h += '输出:' + m.maxOutputTokens.toLocaleString();
        h += '</div>';
      }
      h += '</div>';
    });
    h += '</div></td>';
    h += '<td><div class="cell-actions">';
    if (!isDef) h += '<button class="btn btn-sm" onclick="switchUp(&quot;' + u.name + '&quot;)">默认</button>';
    h += '<button class="btn btn-sm" onclick="editUp(&quot;' + u.name + '&quot;)">编辑</button>';
    h += '<button class="btn btn-sm btn-danger" onclick="delUp(&quot;' + u.name + '&quot;)">删除</button>';
    h += '</div></td></tr>';
  });
  h += '</tbody></table>';
  el.innerHTML = h;
}

/* ── Model card editor ── */
function addModelCard(m) {
  m = m || {};
  editingModels.push({
    id: m.id || '',
    toolCalling: !!m.toolCalling,
    imageInput: !!m.imageInput,
    thinking: !!m.thinking,
    allowCloseThinking: !!m.allowCloseThinking,
    thinkingIntensity: (m.thinkingIntensity || []).join(','),
    maxInputTokens: m.maxInputTokens || '',
    maxOutputTokens: m.maxOutputTokens || ''
  });
  renderModelCards();
}

function removeModelCard(idx) {
  editingModels.splice(idx, 1);
  renderModelCards();
}

function renderModelCards() {
  var el = E('model-cards');
  if (!editingModels.length) {
    el.innerHTML = '<div style="color:var(--text2);font-size:12px;padding:8px 0">暂无模型，点击 "+ 添加模型" 添加</div>';
    return;
  }
  var h = '';
  editingModels.forEach(function(m, i) {
    h += '<div class="model-card">';
    h += '<div class="model-card-header"><span class="model-num">模型 #' + (i + 1) + '</span>';
    h += '<button class="btn btn-sm btn-danger" onclick="removeModelCard(' + i + ')">移除</button></div>';
    h += '<div class="form-group"><label>模型 ID</label>';
    h += '<input data-idx="' + i + '" data-field="id" value="' + escAttr(m.id) + '" placeholder="model-id" oninput="updateModelField(this)"></div>';
    h += '<div class="checkbox-row">';
    h += '<label class="checkbox-label" title="实际生效：决定多模态消息是否被剥离后转发给上游"><input type="checkbox" data-idx="' + i + '" data-field="imageInput"' + (m.imageInput ? ' checked' : '') + ' onchange="updateModelCheck(this)"> 图片输入</label>';
    h += '</div>';
    // 元数据区：以下字段目前仅在 dashboard 展示，不会影响代理请求行为
    h += '<details class="model-meta-details">';
    h += '<summary>更多能力（元数据，暂不生效）</summary>';
    h += '<div class="checkbox-row">';
    h += '<label class="checkbox-label"><input type="checkbox" data-idx="' + i + '" data-field="toolCalling"' + (m.toolCalling ? ' checked' : '') + ' onchange="updateModelCheck(this)"> 工具调用</label>';
    h += '<label class="checkbox-label"><input type="checkbox" data-idx="' + i + '" data-field="thinking"' + (m.thinking ? ' checked' : '') + ' onchange="updateModelCheck(this)"> 思考模式</label>';
    h += '<label class="checkbox-label"><input type="checkbox" data-idx="' + i + '" data-field="allowCloseThinking"' + (m.allowCloseThinking ? ' checked' : '') + ' onchange="updateModelCheck(this)"> 允许关闭思考</label>';
    h += '</div>';
    h += '<div class="form-group"><label>思考强度（逗号分隔，留空=自动）<span class="placeholder-hint"> · 规划中，未生效</span></label>';
    h += '<input data-idx="' + i + '" data-field="thinkingIntensity" value="' + escAttr(m.thinkingIntensity) + '" placeholder="Minimal,Low,Medium,High,X-High,Max" oninput="updateModelField(this)" disabled></div>';
    h += '<div class="token-row">';
    h += '<div class="form-group"><label>输入 Token 上限<span class="placeholder-hint"> · 规划中，未生效</span></label>';
    h += '<input type="number" data-idx="' + i + '" data-field="maxInputTokens" value="' + (m.maxInputTokens || '') + '" placeholder="262144" oninput="updateModelField(this)" disabled></div>';
    h += '<div class="form-group"><label>输出 Token 上限<span class="placeholder-hint"> · 规划中，未生效</span></label>';
    h += '<input type="number" data-idx="' + i + '" data-field="maxOutputTokens" value="' + (m.maxOutputTokens || '') + '" placeholder="8192" oninput="updateModelField(this)" disabled></div>';
    h += '</div>';
    h += '</details>';
    h += '</div>';
  });
  el.innerHTML = h;
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateModelField(el) {
  var idx = parseInt(el.dataset.idx);
  var field = el.dataset.field;
  editingModels[idx][field] = el.value;
}

function updateModelCheck(el) {
  var idx = parseInt(el.dataset.idx);
  var field = el.dataset.field;
  editingModels[idx][field] = el.checked;
}

function collectModels() {
  return editingModels.filter(function(m) { return m.id.trim(); }).map(function(m) {
    var obj = { id: m.id.trim() };
    if (m.toolCalling) obj.toolCalling = true;
    if (m.imageInput) obj.imageInput = true;
    if (m.thinking) obj.thinking = true;
    if (m.allowCloseThinking) obj.allowCloseThinking = true;
    var intensities = m.thinkingIntensity.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    if (intensities.length) obj.thinkingIntensity = intensities;
    var inp = parseInt(m.maxInputTokens);
    if (inp > 0) obj.maxInputTokens = inp;
    var outp = parseInt(m.maxOutputTokens);
    if (outp > 0) obj.maxOutputTokens = outp;
    return obj;
  });
}

/* ── Upstream CRUD ── */
async function switchUp(n) {
  await api('/admin/upstream/default', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: n })
  });
  refresh();
}

async function clearStats() {
  await fetch('/stats', { method: 'DELETE' });
  refresh();
}

async function setWarmer() {
  await api('/admin/warmer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interval: parseInt(E('warmer-sel').value) })
  });
  refresh();
}

async function testCache() {
  var u = data.upstreams.find(function(x) { return x.name === data.default; });
  if (!u) return alert('no default');
  var m = u.models[0];
  var mid = typeof m === 'string' ? m : m.id;
  var b = JSON.stringify({
    model: mid,
    messages: [{ role: 'user', content: 'Test' }],
    max_tokens: 5,
    stream: false
  });
  var url = u.apiFormat === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b });
  await new Promise(function(r) { setTimeout(r, 2000); });
  var r2 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b });
  var d = await r2.json();
  var u2 = d.usage || {};
  var hit = u2.prompt_cache_hit_tokens || u2.cache_read_input_tokens || 0;
  var miss = u2.prompt_cache_miss_tokens || u2.cache_creation_input_tokens || 0;
  alert('命中: ' + hit.toLocaleString() + ', 未命中: ' + miss.toLocaleString() + ', 命中率: ' + (hit + miss > 0 ? (hit / (hit + miss) * 100).toFixed(1) : '0') + '%');
  refresh();
}

function openAdd() {
  E('m-title').textContent = '新增上游';
  E('f-org').value = '';
  E('f-name').value = '';
  E('f-url').value = '';
  E('f-key').value = '';
  E('f-format').value = 'openai';
  E('f-cache').value = 'implicit';
  E('f-norm').value = 'safe';
  E('f-multi').checked = false;
  E('f-cc').checked = false;
  E('f-disabled').checked = false;
  E('f-priority').value = '100';
  syncConfigOptions();
  editingModels = [];
  renderModelCards();
  E('mod').classList.add('show');
  E('f-name').focus();
}

async function editUp(name) {
  var raw = await api('/admin/upstreams/' + encodeURIComponent(name));
  E('m-title').textContent = '编辑 ' + name;
  E('f-org').value = name;
  E('f-name').value = raw.name;
  E('f-url').value = raw.baseURL;
  E('f-key').value = raw.apiKey || '';
  E('f-format').value = raw.apiFormat || 'openai';
  E('f-cache').value = raw.cacheMode || (E('f-format').value === 'anthropic' ? 'active' : 'implicit');
  E('f-norm').value = raw.normalization || 'safe';
  E('f-multi').checked = !!raw.multimodal;
  E('f-cc').checked = raw.supportsCacheControl !== false;
  E('f-disabled').checked = raw.disabled === true;
  E('f-priority').value = String(typeof raw.priority === "number" ? raw.priority : 100);
  syncConfigOptions();
  editingModels = (raw.models || []).map(function(m) {
    if (typeof m === 'string') return { id: m, toolCalling: false, imageInput: false, thinking: false, allowCloseThinking: false, thinkingIntensity: '', maxInputTokens: '', maxOutputTokens: '' };
    return {
      id: m.id || '',
      toolCalling: !!m.toolCalling,
      imageInput: !!m.imageInput,
      thinking: !!m.thinking,
      allowCloseThinking: !!m.allowCloseThinking,
      thinkingIntensity: (m.thinkingIntensity || []).join(','),
      maxInputTokens: m.maxInputTokens || '',
      maxOutputTokens: m.maxOutputTokens || ''
    };
  });
  renderModelCards();
  E('mod').classList.add('show');
}

function closeMod() { E('mod').classList.remove('show'); }

async function save() {
  var name = E('f-name').value.trim();
  var url = E('f-url').value.trim();
  var key = E('f-key').value.trim();
  var format = E('f-format').value;
  var cache = E('f-cache').value;
  var normalization = E('f-norm').value;
  var multi = E('f-multi').checked;
  var cc = E('f-cc').checked;
  var disabled = E('f-disabled').checked;
  var priority = parseInt(E('f-priority').value, 10);
  if (!Number.isFinite(priority)) priority = 100;
  var models = collectModels();
  if (!name || !url) return alert('名称和地址不能为空');
  if (!key || key.indexOf('\u2022') >= 0) {
    var orig = data.upstreams.find(function(x) { return x.name === name; });
    if (orig) {
      try { var r = await api('/admin/upstreams/' + encodeURIComponent(name)); key = r.apiKey; } catch (e) {}
    }
  }
  await api('/admin/upstreams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name, baseURL: url, apiKey: key, models: models, apiFormat: format, cacheMode: cache, normalization: normalization, multimodal: multi, supportsCacheControl: cc, disabled: disabled, priority: priority })
  });
  closeMod();
  refresh();
}

async function delUp(name) {
  if (!confirm('delete ' + name + '?')) return;
  await api('/admin/upstreams/' + encodeURIComponent(name), { method: 'DELETE' });
  refresh();
}

document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeMod(); });
E('mod').addEventListener('click', function(e) { if (e.target.id === 'mod') closeMod(); });
E('f-format').addEventListener('change', syncConfigOptions);
E('f-cache').addEventListener('change', syncConfigOptions);
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}
