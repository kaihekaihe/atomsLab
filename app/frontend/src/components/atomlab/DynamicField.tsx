import { useId, type ReactNode } from 'react';
import type { AppField } from '@/lib/atomlab/types';

function FieldLabel({ field, wide, children }: { field: AppField; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-sm font-medium text-stone-700">
        {field.label}
        {field.required && <em className="not-italic text-rose-500"> *</em>}
      </span>
      {children}
    </label>
  );
}

interface DynamicFieldProps {
  field: AppField;
  value: unknown;
  onChange: (v: unknown) => void;
  accent?: string;
}

/** 按字段 kind 分派表单项：text / textarea / number / date / select / boolean。 */
export function DynamicField({ field, value, onChange, accent = '#6c5ce7' }: DynamicFieldProps) {
  const id = useId();

  if (field.kind === 'boolean') {
    const on = Boolean(value);
    return (
      <label
        htmlFor={id}
        className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2.5"
      >
        <span>
          <span className="block text-sm font-medium text-stone-700">{field.label}</span>
          <span className="block text-xs text-stone-400">{on ? '是' : '否'}</span>
        </span>
        <span
          className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition"
          style={{ background: on ? accent : '#d6d3d1' }}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </span>
        <input id={id} className="sr-only" type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      </label>
    );
  }

  if (field.kind === 'select') {
    return (
      <FieldLabel field={field}>
        <select id={id} className="al-input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          <option value="">{field.hint || '请选择'}</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </FieldLabel>
    );
  }

  if (field.kind === 'textarea') {
    return (
      <FieldLabel field={field} wide>
        <textarea
          id={id}
          rows={3}
          className="al-input resize-none"
          placeholder={field.hint}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      </FieldLabel>
    );
  }

  const type = field.kind === 'number' ? 'number' : field.kind === 'date' ? 'date' : 'text';
  return (
    <FieldLabel field={field}>
      <input
        id={id}
        type={type}
        step={field.kind === 'number' ? 'any' : undefined}
        className="al-input"
        placeholder={field.hint}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    </FieldLabel>
  );
}
