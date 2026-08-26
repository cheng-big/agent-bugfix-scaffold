// 零依赖 JSON Schema 校验器（draft-07 子集）。
// 支持：type、required、enum、properties、additionalProperties(false)、items、
//        minLength/maxLength、minItems/maxItems、minimum、pattern、多类型(["string","null"])。
// 覆盖本项目 schema 所需能力，不追求完整 draft-07。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const cache = new Map();

export function loadSchema(name) {
  if (cache.has(name)) return cache.get(name);
  const s = JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8'));
  cache.set(name, s);
  return s;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // string | number | boolean | object
}

function typeMatches(expected, actual) {
  const list = Array.isArray(expected) ? expected : [expected];
  return list.some((t) => {
    if (t === 'number') return actual === 'number' || actual === 'integer';
    return t === actual;
  });
}

function walk(schema, value, path, errors) {
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    if (!typeMatches(schema.type, actual)) {
      errors.push(`${path || '/'}: 期望类型 ${JSON.stringify(schema.type)}，实际 ${actual}`);
      return; // 类型不符，后续检查无意义
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path || '/'}: 值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)} 内`);
  }

  const actual = typeOf(value);

  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path}: 字符串长度 ${value.length} < minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path}: 字符串长度 ${value.length} > maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      errors.push(`${path}: 值不匹配 pattern ${schema.pattern}`);
  }

  if (actual === 'integer' || actual === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path}: 数值 ${value} < minimum ${schema.minimum}`);
  }

  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path}: 数组长度 ${value.length} < minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path}: 数组长度 ${value.length} > maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((el, i) => walk(schema.items, el, `${path}[${i}]`, errors));
  }

  if (actual === 'object') {
    const props = schema.properties || {};
    if (Array.isArray(schema.required)) {
      for (const k of schema.required)
        if (!(k in value)) errors.push(`${path || '/'}: 缺少必填字段 "${k}"`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value))
        if (!(k in props)) errors.push(`${path || '/'}: 出现未知字段 "${k}"`);
    }
    for (const [k, sub] of Object.entries(props))
      if (k in value) walk(sub, value[k], `${path}/${k}`, errors);
  }
}

// 返回 { valid, errors:[] }
export function validate(schemaOrName, value) {
  const schema = typeof schemaOrName === 'string' ? loadSchema(schemaOrName) : schemaOrName;
  const errors = [];
  walk(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}
