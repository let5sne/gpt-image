const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('public/index.html inline <script> parses without syntax errors', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'expected at least one inline <script> block');

  const source = match[1];
  assert.doesNotThrow(
    () => new vm.Script(source, { filename: 'public/index.html#script' }),
    'inline frontend script must be syntactically valid'
  );
});
