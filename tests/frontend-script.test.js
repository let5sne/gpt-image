const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
