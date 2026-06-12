import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import YAML from 'yaml';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(currentDir, '../..');
export const schemaPath = path.join(pluginRoot, 'schemas/crud-spec.schema.json');

export function readStructuredFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const content = fs.readFileSync(absolutePath, 'utf8');

  if (extension === '.json') {
    return JSON.parse(content);
  }

  if (extension === '.yaml' || extension === '.yml') {
    return YAML.parse(content);
  }

  throw new Error(`unsupported spec extension: ${extension}`);
}

export function normalizeSpec(spec) {
  const className = `${spec.module.name.charAt(0).toUpperCase()}${spec.module.name.slice(1)}`;
  const segments = spec.module.menuPath.split('/');
  const frontendBase = segments.join('/');
  const apiRoot = segments[0];

  return {
    ...spec,
    derived: {
      className,
      variableName: spec.module.name,
      tableName: spec.module.table,
      apiBase: `/${apiRoot}/${spec.module.name}`,
      backendPackage: spec.module.package,
      backendPackagePath: spec.module.package.replaceAll('.', '/'),
      frontendApiDir: `src/api/${frontendBase}`,
      frontendViewDir: `src/views/${frontendBase}`,
    },
  };
}

export function loadAndValidateSpec(filePath) {
  const schema = readStructuredFile(schemaPath);
  const spec = readStructuredFile(filePath);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(spec);

  return {
    valid,
    spec: valid ? normalizeSpec(spec) : spec,
    errors: validate.errors || [],
  };
}
