import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import YAML from 'yaml';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(currentDir, '../..');
export const schemaPath = path.join(pluginRoot, 'schemas/crud-spec.schema.json');

export class SpecInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpecInputError';
    this.code = code;
    this.errors = [{ instancePath: '', message, keyword: code }];
  }
}

export function readStructuredFile(filePath) {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();

  if (!['.json', '.yaml', '.yml'].includes(extension)) {
    throw new SpecInputError('unsupported_extension', `unsupported spec extension: ${extension || '(none)'}`);
  }

  let content;
  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new SpecInputError('file_not_found', `spec file not found: ${absolutePath}`);
    }

    throw new SpecInputError('file_read_error', `failed to read spec file: ${absolutePath}`);
  }

  if (extension === '.json') {
    try {
      return JSON.parse(content);
    } catch (error) {
      throw new SpecInputError('invalid_json', `failed to parse JSON spec: ${error.message}`);
    }
  }

  try {
    return YAML.parse(content);
  } catch (error) {
    throw new SpecInputError('invalid_yaml', `failed to parse YAML spec: ${error.message}`);
  }
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

export function validateSemanticSpec(spec) {
  const errors = [];
  const seenFieldNames = new Set();

  spec.fields.forEach((field, index) => {
    if (seenFieldNames.has(field.name)) {
      errors.push({
        instancePath: `/fields/${index}/name`,
        message: `duplicate field name: ${field.name}`,
        keyword: 'duplicateField',
      });
    }
    seenFieldNames.add(field.name);

    if (Object.hasOwn(field, 'default')) {
      if (field.type === 'string' && typeof field.default !== 'string') {
        errors.push({
          instancePath: `/fields/${index}/default`,
          message: `string default must be a string: ${field.name}`,
          keyword: 'invalidDefaultType',
        });
      }

      if (field.type === 'integer' && typeof field.default !== 'number') {
        errors.push({
          instancePath: `/fields/${index}/default`,
          message: `integer default must be an integer: ${field.name}`,
          keyword: 'invalidDefaultType',
        });
      }
    }

    if (field.type === 'enum' && Object.hasOwn(field, 'default')) {
      const hasStringDefault = typeof field.default === 'string';
      const includesDefault = Array.isArray(field.options) && field.options.includes(field.default);

      if (!hasStringDefault || !includesDefault) {
        errors.push({
          instancePath: `/fields/${index}/default`,
          message: `enum default must be one of options: ${field.name}`,
          keyword: 'invalidEnumDefault',
        });
      }
    }
  });

  const fieldNames = new Set(spec.fields.map((field) => field.name));
  spec.acceptance.frontend.formFields.forEach((fieldName, index) => {
    if (!fieldNames.has(fieldName)) {
      errors.push({
        instancePath: `/acceptance/frontend/formFields/${index}`,
        message: `unknown form field: ${fieldName}`,
        keyword: 'unknownFormField',
      });
    }
  });

  return errors;
}

export function loadAndValidateSpec(filePath) {
  const schema = readStructuredFile(schemaPath);
  const spec = readStructuredFile(filePath);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(spec);

  if (!valid) {
    return {
      valid: false,
      spec,
      errors: validate.errors || [],
    };
  }

  const semanticErrors = validateSemanticSpec(spec);

  if (semanticErrors.length > 0) {
    return {
      valid: false,
      spec,
      errors: semanticErrors,
    };
  }

  return {
    valid: true,
    spec: normalizeSpec(spec),
    errors: [],
  };
}
