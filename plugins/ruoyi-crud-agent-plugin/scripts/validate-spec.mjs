#!/usr/bin/env node
import { loadAndValidateSpec, SpecInputError } from './lib/spec-loader.mjs';

const specPath = process.argv[2];

if (!specPath) {
  console.error(JSON.stringify({
    ok: false,
    code: 'invalid_args',
    message: 'spec path is required',
  }));
  process.exit(2);
}

let result;

try {
  result = loadAndValidateSpec(specPath);
} catch (error) {
  if (error instanceof SpecInputError) {
    console.error(JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message,
      errors: error.errors,
    }));
    process.exit(1);
  }

  console.error(JSON.stringify({
    ok: false,
    code: 'internal_error',
    message: error.message,
  }));
  process.exit(1);
}

if (!result.valid) {
  console.error(JSON.stringify({
    ok: false,
    code: 'invalid_spec',
    errors: result.errors.map(({ instancePath, message, keyword }) => ({
      instancePath,
      message,
      keyword,
    })),
  }));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  module: result.spec.module,
  derived: result.spec.derived,
  fieldCount: result.spec.fields.length,
}));
process.exit(0);
