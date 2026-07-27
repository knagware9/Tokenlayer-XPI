import type { MetadataSchema, PropertySchema } from "../types.js";

/** The kinds of metadata field the low-code builders can capture. */
export type FieldKind = "string" | "number" | "boolean" | "enum" | "document";

/** One editable metadata field — the row model both the token and credential
 * builders edit. Shared so the field editor stays DRY across domains. */
export interface FieldRow {
  name: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  enumValues?: string;
  min?: string;
  max?: string;
  pattern?: string;
}

/** Build the object schema (`{ type, properties, required }`) from the field rows.
 * This is the exact translation the token builder used inline — moved here so the
 * credential builder emits identical claim schemas. */
export function fieldsToSchema(fields: FieldRow[]): MetadataSchema {
  const properties: Record<string, PropertySchema> = {};
  for (const f of fields) {
    const nm = f.name.trim();
    if (!nm) continue;
    let prop: PropertySchema;
    if (f.kind === "enum") {
      const values = (f.enumValues ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      prop = { type: "string", enum: values };
    } else if (f.kind === "document") {
      prop = { type: "document" };
    } else if (f.kind === "number") {
      prop = { type: "number" };
      if (f.min?.trim()) prop.min = Number(f.min);
      if (f.max?.trim()) prop.max = Number(f.max);
    } else if (f.kind === "string") {
      prop = { type: "string" };
      if (f.pattern?.trim()) prop.pattern = f.pattern.trim();
    } else {
      prop = { type: "boolean" };
    }
    if (f.description?.trim()) prop.description = f.description.trim();
    properties[nm] = prop;
  }
  return {
    type: "object",
    properties,
    required: fields.filter((f) => f.required && f.name.trim()).map((f) => f.name.trim()),
  };
}

/** Add / edit / remove metadata field rows. Controlled — the parent owns the list. */
export function SchemaFieldEditor({ fields, onChange }: { fields: FieldRow[]; onChange: (f: FieldRow[]) => void }): JSX.Element {
  const setField = (i: number, patch: Partial<FieldRow>): void =>
    onChange(fields.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const namedFields = fields.filter((f) => f.name.trim());
  const hasEmptyEnum = namedFields.some(
    (f) => f.kind === "enum" && !(f.enumValues ?? "").split(",").map((v) => v.trim()).filter(Boolean).length,
  );
  const hasDuplicateField = new Set(namedFields.map((f) => f.name.trim())).size !== namedFields.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fields</span>
        <button
          type="button"
          onClick={() => onChange([...fields, { name: "", kind: "string", required: false }])}
          className="text-xs text-brand-600 hover:text-brand-700 font-medium"
        >
          + add field
        </button>
      </div>
      <div className="space-y-3">
        {fields.map((f, i) => (
          <div key={i} className="rounded-lg border border-slate-200 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input className="input flex-1" placeholder="field name" value={f.name} onChange={(e) => setField(i, { name: e.target.value })} />
              <select className="select w-36" value={f.kind} onChange={(e) => setField(i, { kind: e.target.value as FieldKind })}>
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="enum">enum</option>
                <option value="document">document</option>
              </select>
              <label className="flex items-center gap-1 text-xs text-slate-500 whitespace-nowrap">
                <input type="checkbox" checked={f.required} onChange={() => setField(i, { required: !f.required })} />
                req
              </label>
              <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 text-sm px-1">
                ×
              </button>
            </div>
            {f.kind === "enum" && (
              <input
                className="input text-xs"
                placeholder="values (comma-separated)"
                value={f.enumValues ?? ""}
                onChange={(e) => setField(i, { enumValues: e.target.value })}
              />
            )}
            <input
              className="input text-xs"
              placeholder="description (optional)"
              value={f.description ?? ""}
              onChange={(e) => setField(i, { description: e.target.value })}
            />
          </div>
        ))}
      </div>
      {hasDuplicateField && <p className="text-xs text-red-600 mt-2">Two fields share the same name — field names must be unique.</p>}
      {hasEmptyEnum && <p className="text-xs text-red-600 mt-2">Every enum field needs at least one value.</p>}
    </div>
  );
}
