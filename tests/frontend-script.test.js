const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractFunctionSource(html, name) {
  const signature = `function ${name}(`;
  const start = html.indexOf(signature);
  assert.notEqual(start, -1, `expected ${name} in inline script`);

  const braceStart = html.indexOf('{', start);
  assert.notEqual(braceStart, -1, `expected opening brace for ${name}`);

  let depth = 0;
  let inString = false;
  let stringChar = null;
  let escaped = false;
  for (let i = braceStart; i < html.length; i += 1) {
    const ch = html[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if ((ch === '"' || ch === '\'' || ch === '`') && !inString) {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === stringChar && inString) {
      inString = false;
      stringChar = null;
      continue;
    }

    if (!inString) {
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return html.slice(start, i + 1);
        }
      }
    }
  }

  assert.fail(`expected closing brace for ${name}`);
}

test('public HTML inline scripts parse without syntax errors', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const files = fs.readdirSync(publicDir).filter((name) => name.endsWith('.html'));
  assert.ok(files.length > 0, 'expected at least one public HTML file');

  for (const file of files) {
    const html = fs.readFileSync(path.join(publicDir, file), 'utf-8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0, `expected at least one inline <script> block in ${file}`);

    scripts.forEach((match, index) => {
      const source = match[1];
      assert.doesNotThrow(
        () => new vm.Script(source, { filename: `public/${file}#script-${index}` }),
        `${file} inline script ${index} must be syntactically valid`
      );
    });
  }
});

test('admin page escapeHtml escapes unsafe markup', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf-8');
  const match = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'expected escapeHtml function in admin.html');

  const escapeHtml = new Function(`return ${match[0]}`)();
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('& < > " \''), '&amp; &lt; &gt; &quot; &#39;');
});

test('admin page renderAuditLogs renders newest entries and escapes detail', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf-8');
  const escapeHtmlMatch = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/);
  assert.ok(escapeHtmlMatch, 'expected escapeHtml function in admin.html');

  const formatNumberSource = extractFunctionSource(html, 'formatNumber');
  const statusClassSource = extractFunctionSource(html, 'statusClass');
  const renderAuditLogsSource = extractFunctionSource(html, 'renderAuditLogs');

  const auditTableWrap = { innerHTML: '' };
  const auditMeta = { textContent: '', className: '' };

  const context = vm.createContext({ auditTableWrap, auditMeta });
  vm.runInContext(`
    ${escapeHtmlMatch[0]}
    ${formatNumberSource}
    ${statusClassSource}
    ${renderAuditLogsSource}
    globalThis.renderAuditLogs = renderAuditLogs;
  `, context);

  context.renderAuditLogs([
    {
      ts: '2026-05-28T10:10:00.000Z',
      action: 'admin_credits_grant_by_email',
      request_id: 'req-3',
      detail: { email_hash: '<unsafe>', credits: 20 },
    },
  ], 1);

  assert.equal(auditMeta.textContent, '最近 1 条');
  assert.equal(auditMeta.className, 'badge ok');
  assert.ok(auditTableWrap.innerHTML.includes('admin_credits_grant_by_email'));
  assert.ok(auditTableWrap.innerHTML.includes('&lt;unsafe&gt;'));
  assert.equal(auditTableWrap.innerHTML.includes('<unsafe>'), false);
  assert.ok(auditTableWrap.innerHTML.includes('data-copy-label="request_id"'));
  assert.ok(auditTableWrap.innerHTML.includes('data-copy-label="detail"'));
});

test('admin page copyText uses clipboard when available', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf-8');
  const copyTextMatch = html.match(/async function copyText\(value\) \{[\s\S]*?\n\}/);
  assert.ok(copyTextMatch, 'expected copyText function in admin.html');

  const calls = [];
  const context = vm.createContext({
    navigator: {
      clipboard: {
        async writeText(value) {
          calls.push(value);
        },
      },
    },
    document: {
      createElement() { throw new Error('fallback should not run'); },
      body: { appendChild() {}, removeChild() {} },
      execCommand() { return false; },
    },
  });

  vm.runInContext(`${copyTextMatch[0]}; globalThis.copyText = copyText;`, context);
  const ok = await context.copyText('req-123');

  assert.equal(ok, true);
  assert.equal(calls[0], 'req-123');
});

test('admin page renderErrorSummary renders top errors and request totals', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf-8');
  const escapeHtmlMatch = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/);
  assert.ok(escapeHtmlMatch, 'expected escapeHtml function in admin.html');

  const formatNumberSource = extractFunctionSource(html, 'formatNumber');
  const renderErrorSummarySource = extractFunctionSource(html, 'renderErrorSummary');

  const errorSummaryWrap = { innerHTML: '' };
  const errorMeta = { textContent: '', className: '' };

  const context = vm.createContext({ errorSummaryWrap, errorMeta });
  vm.runInContext(`
    ${escapeHtmlMatch[0]}
    ${formatNumberSource}
    ${renderErrorSummarySource}
    globalThis.renderErrorSummary = renderErrorSummary;
  `, context);

  context.renderErrorSummary({
    errors_total: 3,
    requests_total: 18,
    error_codes: { unauthorized: 2, invalid_email: 1 },
    by_path: { 'GET /api/admin/metrics': 4, 'POST /api/auth/email/send-code': 3 },
  });

  assert.equal(errorMeta.textContent, '错误 3 / 请求 18');
  assert.equal(errorMeta.className, 'badge bad');
  assert.ok(errorSummaryWrap.innerHTML.includes('unauthorized'));
  assert.ok(errorSummaryWrap.innerHTML.includes('GET /api/admin/metrics'));
});

test('admin page loadAuditLogs sends selected action filter', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf-8');
  const loadAuditLogsMatch = html.match(/async function loadAuditLogs\(\) \{[\s\S]*?\n\}/);
  assert.ok(loadAuditLogsMatch, 'expected async loadAuditLogs function in admin.html');

  const calls = [];
  const context = vm.createContext({
    auditMeta: { textContent: '', className: '' },
    auditTableWrap: { innerHTML: '' },
    auditActionFilter: { value: 'admin_credits_grant_by_email' },
    auditRefreshBtn: { disabled: false },
    escapeHtml(value) { return String(value); },
    renderAuditLogs() {},
    getAdminToken() { return 'admin-secret'; },
    api(path) {
      calls.push(path);
      return Promise.resolve({ entries: [], total: 0 });
    },
  });

  vm.runInContext(`${loadAuditLogsMatch[0]}; globalThis.loadAuditLogs = loadAuditLogs;`, context);
  await context.loadAuditLogs();

  assert.equal(calls[0], '/api/admin/audit-logs?limit=12&action=admin_credits_grant_by_email');
  assert.equal(context.auditRefreshBtn.disabled, false);
});

test('admin page renderSetupHint shows steps and clears content', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf-8');
  const escapeHtmlMatch = html.match(/function escapeHtml\(value\) \{[\s\S]*?\n\}/);
  assert.ok(escapeHtmlMatch, 'expected escapeHtml function in admin.html');

  const renderSetupHintSource = extractFunctionSource(html, 'renderSetupHint');
  const setupHint = { className: '', innerHTML: '' };
  const context = vm.createContext({ setupHint });

  vm.runInContext(`
    ${escapeHtmlMatch[0]}
    ${renderSetupHintSource}
    globalThis.renderSetupHint = renderSetupHint;
  `, context);

  context.renderSetupHint({
    title: '后台未配置 ADMIN_TOKEN',
    steps: ['设置 ADMIN_TOKEN', '重启 npm run dev'],
  });

  assert.equal(setupHint.className, 'setup-hint is-visible');
  assert.ok(setupHint.innerHTML.includes('后台未配置 ADMIN_TOKEN'));
  assert.ok(setupHint.innerHTML.includes('设置 ADMIN_TOKEN'));

  context.renderSetupHint();
  assert.equal(setupHint.className, 'setup-hint');
  assert.equal(setupHint.innerHTML, '');
});

test('index page parseCooldownSeconds parses retry seconds safely', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  const fnSource = extractFunctionSource(html, 'parseCooldownSeconds');

  const context = vm.createContext({});
  vm.runInContext(`${fnSource}; globalThis.parseCooldownSeconds = parseCooldownSeconds;`, context);
  const parseCooldownSeconds = context.parseCooldownSeconds;

  assert.equal(parseCooldownSeconds('请 60 秒后重试'), 60);
  assert.equal(parseCooldownSeconds('retry after 15s'), 15);
  assert.equal(parseCooldownSeconds('稍后重试'), 0);
  assert.equal(parseCooldownSeconds('0 秒后重试'), 0);
});

test('index page updateAuthActionButtons reflects loading and cooldown states', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  const setButtonStateSource = extractFunctionSource(html, 'setButtonState');
  const updateSource = extractFunctionSource(html, 'updateAuthActionButtons');

  const buttons = {
    sendCodeBtn: { disabled: false, textContent: '发码', dataset: {} },
    verifyCodeBtn: { disabled: false, textContent: '登录', dataset: {} },
    logoutBtn: { disabled: false, textContent: '登出', dataset: {} },
  };

  const context = vm.createContext({
    document: {
      getElementById(id) {
        return buttons[id] || null;
      },
    },
  });

  vm.runInContext(`
    let sendCodeInFlight = false;
    let verifyCodeInFlight = false;
    let logoutInFlight = false;
    let sendCodeCooldownSeconds = 0;
    ${setButtonStateSource}
    ${updateSource}
    globalThis.harness = {
      setState(next) {
        if ('sendCodeInFlight' in next) sendCodeInFlight = next.sendCodeInFlight;
        if ('verifyCodeInFlight' in next) verifyCodeInFlight = next.verifyCodeInFlight;
        if ('logoutInFlight' in next) logoutInFlight = next.logoutInFlight;
        if ('sendCodeCooldownSeconds' in next) sendCodeCooldownSeconds = next.sendCodeCooldownSeconds;
      },
      apply() {
        updateAuthActionButtons();
      },
    };
  `, context);

  context.harness.setState({ sendCodeInFlight: true });
  context.harness.apply();
  assert.equal(buttons.sendCodeBtn.disabled, true);
  assert.equal(buttons.sendCodeBtn.textContent, '发送中...');

  context.harness.setState({ sendCodeInFlight: false, sendCodeCooldownSeconds: 12 });
  context.harness.apply();
  assert.equal(buttons.sendCodeBtn.disabled, true);
  assert.equal(buttons.sendCodeBtn.textContent, '12s 后重发');

  context.harness.setState({ sendCodeCooldownSeconds: 0, verifyCodeInFlight: true, logoutInFlight: true });
  context.harness.apply();
  assert.equal(buttons.sendCodeBtn.disabled, false);
  assert.equal(buttons.sendCodeBtn.textContent, '发码');
  assert.equal(buttons.verifyCodeBtn.disabled, true);
  assert.equal(buttons.verifyCodeBtn.textContent, '登录中...');
  assert.equal(buttons.logoutBtn.disabled, true);
  assert.equal(buttons.logoutBtn.textContent, '登出中...');
});
