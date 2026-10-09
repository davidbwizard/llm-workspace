/** The subset of MCP form schemas Fleet can faithfully display and validate.
 * Unknown constraints use the native client rather than silently weakening a form. */
export type CodexFormValue = string | number | boolean;
export type CodexFormField = {
  id: string; label: string; description: string; required: boolean;
  type: 'string' | 'number' | 'integer' | 'boolean';
  options?: { value: string; label: string }[];
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time'; secret?: boolean; default?: CodexFormValue;
};
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  ? v as Record<string, unknown> : null;
const clean = (v: unknown): string => typeof v === 'string'
  ? v.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/g, ' ').slice(0, 2000) : '';
const only = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).every(k => keys.includes(k));

/** null schema is a message-only approval; null return is unsupported. */
export function codexFormFields(schema: unknown): CodexFormField[] | null {
  if (schema === null) return [];
  const s = object(schema);
  if (!s || !only(s, ['$schema', 'type', 'properties', 'required', 'title', 'description', 'additionalProperties'])
    || (s.additionalProperties !== undefined && s.additionalProperties !== false)
    || (s.type !== 'object' && Object.keys(s).length !== 0)) return null;
  const properties = object(s.properties ?? {});
  if (!properties || Object.keys(properties).length > 32) return null;
  const required = s.required ?? [];
  if (!Array.isArray(required) || required.some(id => typeof id !== 'string' || !Object.hasOwn(properties, id))) return null;
  const fields: CodexFormField[] = [];
  for (const [id, raw] of Object.entries(properties)) {
    const p = object(raw);
    if (!id || id.length > 200 || !p || !['string', 'number', 'integer', 'boolean'].includes(String(p.type))) return null;
    const type = p.type as CodexFormField['type'];
    const allowed = ['type', 'title', 'description', 'default'];
    if (type === 'string') allowed.push('minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf', 'writeOnly');
    if (type === 'number' || type === 'integer') allowed.push('minimum', 'maximum');
    if (!only(p, allowed)) return null;
    const field: CodexFormField = { id, type, required: required.includes(id), label: clean(p.title) || clean(id), description: clean(p.description) };
    for (const k of ['minLength', 'maxLength', 'minimum', 'maximum'] as const) {
      if (p[k] === undefined) continue;
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k])
        || ((k === 'minLength' || k === 'maxLength') && (!Number.isSafeInteger(p[k]) || p[k] < 0 || p[k] > 2000))) return null;
      field[k] = p[k];
    }
    if ((field.minLength ?? 0) > (field.maxLength ?? 2000)
      || (field.minimum ?? -Infinity) > (field.maximum ?? Infinity)) return null;
    if (p.format !== undefined) {
      if (!['email', 'uri', 'date', 'date-time', 'password'].includes(String(p.format))) return null;
      if (p.format === 'password') field.secret = true;
      else field.format = p.format as CodexFormField['format'];
    }
    if (p.writeOnly !== undefined && typeof p.writeOnly !== 'boolean') return null;
    if (p.writeOnly === true) field.secret = true;
    if (p.enum !== undefined || p.oneOf !== undefined) {
      if (p.enum !== undefined && p.oneOf !== undefined) return null;
      if (p.enum !== undefined) {
        if (!Array.isArray(p.enum) || p.enum.length === 0 || p.enum.length > 100
          || p.enum.some(v => typeof v !== 'string' || v.length > 2000)
          || (p.enumNames !== undefined && (!Array.isArray(p.enumNames) || p.enumNames.length !== p.enum.length
            || p.enumNames.some(v => typeof v !== 'string')))) return null;
        field.options = p.enum.map((value, i) => ({ value: value as string, label: clean((p.enumNames as string[] | undefined)?.[i] ?? value) }));
      } else {
        if (!Array.isArray(p.oneOf) || p.oneOf.length === 0 || p.oneOf.length > 100) return null;
        field.options = [];
        for (const rawOption of p.oneOf) {
          const o = object(rawOption);
          if (!o || !only(o, ['const', 'title']) || typeof o.const !== 'string' || o.const.length > 2000
            || (o.title !== undefined && typeof o.title !== 'string')) return null;
          field.options.push({ value: o.const, label: clean(o.title ?? o.const) });
        }
      }
    } else if (p.enumNames !== undefined) return null;
    if (p.default !== undefined) {
      if (!validCodexFormValue(field, p.default)) return null;
      field.default = p.default as CodexFormValue;
    }
    fields.push(field);
  }
  return fields;
}

export function validCodexFormValue(field: CodexFormField, value: unknown): value is CodexFormValue {
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number' || field.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (field.type !== 'integer' || Number.isSafeInteger(value))
    && value >= (field.minimum ?? -Infinity) && value <= (field.maximum ?? Infinity);
  if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f\x7f-\x9f]/.test(value)
    || [...value].length < (field.minLength ?? 0) || [...value].length > (field.maxLength ?? 2000)
 || (field.options && !field.options.some(o => o.value === value))) return false;
  switch (field.format) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri': try { return Boolean(new URL(value).protocol); } catch { return false; }
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))
      && new Date(value).toISOString().slice(0, 10) === value;
    case 'date-time': return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
    default: return true;
  }
}

export function validCodexFormContent(fields: CodexFormField[], content: unknown): content is Record<string, CodexFormValue> {
  const c = object(content);
  return c !== null && Object.keys(c).every(id => fields.some(f => f.id === id))
    && fields.every(f => Object.hasOwn(c, f.id) ? validCodexFormValue(f, c[f.id]) : !f.required);
}
