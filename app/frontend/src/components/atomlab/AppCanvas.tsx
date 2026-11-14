import { useMemo, useState, type FormEvent } from 'react';
import { Grid2X2, LayoutList, Pencil, Plus, Rows3, Search, Trash2, X } from 'lucide-react';
import type { AppBlueprint, AppField, RecordData } from '@/lib/atomlab/types';
import { computeStats, MODE_CN } from '@/lib/atomlab/stats';
import { DynamicField } from './DynamicField';

interface AppCanvasProps {
  blueprint: AppBlueprint;
  records: RecordData[];
  readOnly?: boolean;
  onCreate?: (values: Record<string, unknown>) => Promise<void>;
  onEdit?: (id: number, values: Record<string, unknown>) => Promise<void>;
  onDelete?: (id: number) => Promise<void>;
  onMove?: (id: number, partial: Record<string, unknown>) => Promise<void>;
}

const PILLS = [
  'border-violet-200 bg-violet-50 text-violet-700',
  'border-sky-200 bg-sky-50 text-sky-700',
  'border-amber-200 bg-amber-50 text-amber-700',
  'border-emerald-200 bg-emerald-50 text-emerald-700',
  'border-rose-200 bg-rose-50 text-rose-700',
  'border-stone-200 bg-stone-100 text-stone-600',
];

function Cell({ field, value }: { field: AppField; value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-stone-300">—</span>;
  if (field.kind === 'boolean') {
    return (
      <span
        className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
          value ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-stone-200 bg-stone-100 text-stone-500'
        }`}
      >
        {value ? '是' : '否'}
      </span>
    );
  }
  if (field.kind === 'select') {
    const idx = field.options?.indexOf(String(value)) ?? -1;
    return (
      <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${PILLS[Math.max(idx, 0) % PILLS.length]}`}>
        {String(value)}
      </span>
    );
  }
  if (field.kind === 'number') {
    const n = Number(value);
    if (field.display === 'currency') return <span>¥{n.toLocaleString()}</span>;
    if (field.display === 'percent') return <span>{n}%</span>;
    return <span>{n.toLocaleString()}</span>;
  }
  return <span className="break-all">{String(value)}</span>;
}

function RowActions({ canEdit, canRemove, onEdit, onRemove, size = 13 }: {
  canEdit: boolean;
  canRemove: boolean;
  onEdit: () => void;
  onRemove: () => void;
  size?: number;
}) {
  if (!canEdit && !canRemove) return null;
  return (
    <span className="flex shrink-0 gap-0.5 opacity-60 hover:opacity-100">
      {canEdit && (
        <button title="编辑" onClick={onEdit} className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700">
          <Pencil size={size} />
        </button>
      )}
      {canRemove && (
        <button title="删除" onClick={onRemove} className="rounded p-1 text-stone-400 hover:bg-rose-50 hover:text-rose-500">
          <Trash2 size={size} />
        </button>
      )}
    </span>
  );
}

/** 蓝图运行时：按 AppBlueprint 渲染统计卡 + 表格/看板/卡片视图 + 记录表单。 */
export function AppCanvas({ blueprint, records, readOnly = false, onCreate, onEdit, onDelete, onMove }: AppCanvasProps) {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RecordData | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [dragId, setDragId] = useState<number | null>(null);
  const [overGroup, setOverGroup] = useState<string | null>(null);

  const fields = blueprint.data.fields;
  const entity = blueprint.data.entity;
  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);
  const columns = useMemo(
    () => blueprint.views.columns.map((n) => fieldMap.get(n)).filter((f): f is AppField => Boolean(f)),
    [blueprint.views.columns, fieldMap],
  );
  const groupByField = blueprint.views.groupBy ? fieldMap.get(blueprint.views.groupBy) : undefined;
  const titleField = columns.find((f) => f.name !== groupByField?.name) ?? columns[0];
  const stats = useMemo(() => computeStats(blueprint, records), [blueprint, records]);
  const canEdit = !readOnly && blueprint.actions.update && Boolean(onEdit);
  const canRemove = !readOnly && blueprint.actions.remove && Boolean(onDelete);
  const canCreate = !readOnly && blueprint.actions.create && Boolean(onCreate);
  const canMove = !readOnly && blueprint.actions.update && Boolean(groupByField) && Boolean(onMove);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return records.filter((r) => {
      const okSearch = !term || Object.values(r.data).some((v) => String(v ?? '').toLowerCase().includes(term));
      const okGroup = !groupByField || !group || String(r.data[groupByField.name] ?? '') === group;
      return okSearch && okGroup;
    });
  }, [records, search, group, groupByField]);

  const groupOptions = useMemo(() => {
    if (!groupByField) return [];
    const base = [...(groupByField.options ?? [])];
    for (const r of records) {
      const v = r.data[groupByField.name];
      if (v !== undefined && v !== null && v !== '' && !base.includes(String(v))) base.push(String(v));
    }
    return base;
  }, [groupByField, records]);

  const emptyValues = () => Object.fromEntries(fields.map((f) => [f.name, f.kind === 'boolean' ? false : '']));

  const openCreate = () => {
    setEditing(null);
    setValues(emptyValues());
    setFormError('');
    setFormOpen(true);
  };

  const openEdit = (r: RecordData) => {
    setEditing(r);
    setValues({ ...emptyValues(), ...r.data });
    setFormError('');
    setFormOpen(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      const payload: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.name];
        payload[f.name] = f.kind === 'number' && v !== '' && v !== null && v !== undefined && !Number.isNaN(Number(v)) ? Number(v) : v;
      }
      if (editing) await onEdit?.(editing.id, payload);
      else await onCreate?.(payload);
      setFormOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = (r: RecordData) => {
    if (!window.confirm(`确定删除这条「${entity}」吗？`)) return;
    void onDelete?.(r.id);
  };

  const drop = (g: string) => {
    const rec = records.find((r) => r.id === dragId);
    if (rec && groupByField && canMove && String(rec.data[groupByField.name] ?? '') !== g) {
      void onMove?.(rec.id, { [groupByField.name]: g });
    }
    setDragId(null);
    setOverGroup(null);
  };

  const ModeIcon = blueprint.views.mode === 'kanban' ? Grid2X2 : blueprint.views.mode === 'cards' ? Rows3 : LayoutList;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-5 py-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xl" style={{ background: `${blueprint.app.accent}1a` }}>
          {blueprint.app.icon}
        </div>
        <div className="min-w-0">
          <h2 className="truncate font-semibold leading-tight text-stone-900">{blueprint.app.name}</h2>
          <p className="truncate text-xs text-stone-500">{blueprint.app.tagline}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-stone-400">
          <span className="al-badge border border-stone-200 bg-stone-50 text-stone-500">
            <ModeIcon size={11} />
            {MODE_CN[blueprint.views.mode]}视图
          </span>
          <span>
            {records.length} 条{entity}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        {stats.length > 0 && (
          <div className={`grid grid-cols-2 gap-3 ${stats.length > 2 ? 'lg:grid-cols-3' : 'lg:grid-cols-2'}`}>
            {stats.map((s) => (
              <div key={s.label} className="al-card px-4 py-3">
                <div className="text-xs text-stone-500">{s.label}</div>
                <div className="mt-1 text-2xl font-semibold" style={{ color: blueprint.app.accent }}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input className="al-input pl-9" placeholder={`搜索${entity}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          {groupByField && (
            <select className="al-input w-auto" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">全部{groupByField.label}</option>
              {groupOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          )}
          {canCreate && (
            <button className="al-btn-primary ml-auto" onClick={openCreate}>
              <Plus size={14} /> 新增{entity}
            </button>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="grid place-items-center rounded-xl border border-dashed border-stone-300 bg-white/60 py-16 text-center">
            <span className="text-2xl">🗒️</span>
            <p className="mt-2 text-sm text-stone-500">{search || group ? '没有符合当前条件的记录' : `暂无${entity}数据`}</p>
            {canCreate && !search && !group && (
              <button className="al-btn-outline mt-4" onClick={openCreate}>
                <Plus size={14} /> 新增第一条
              </button>
            )}
          </div>
        ) : blueprint.views.mode === 'kanban' && groupByField ? (
          <div className="flex items-start gap-3 overflow-x-auto pb-2">
            {groupOptions.map((g) => {
              const items = filtered.filter((r) => String(r.data[groupByField.name] ?? '') === g);
              // 空列自动隐藏；拖拽进行中保留空列作为投放目标
              if (items.length === 0 && dragId === null) return null;
              return (
                <div
                  key={g}
                  onDragOver={(e) => {
                    if (!canMove) return;
                    e.preventDefault();
                    setOverGroup(g);
                  }}
                  onDragLeave={() => setOverGroup((cur) => (cur === g ? null : cur))}
                  onDrop={() => drop(g)}
                  className={`w-64 shrink-0 rounded-xl p-2 transition ${
                    overGroup === g ? 'bg-violet-100/70 ring-2 ring-violet-300' : 'bg-stone-200/50'
                  }`}
                >
                  <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-stone-600">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: blueprint.app.accent }} />
                    {g}
                    <span className="ml-auto rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium text-stone-400">{items.length}</span>
                  </div>
                  <div className="mt-1 min-h-[48px] space-y-2">
                    {items.map((r) => (
                      <div
                        key={r.id}
                        draggable={canMove}
                        onDragStart={() => setDragId(r.id)}
                        onDragEnd={() => {
                          setDragId(null);
                          setOverGroup(null);
                        }}
                        className={`al-card p-3 ${canMove ? 'cursor-grab active:cursor-grabbing' : ''} ${dragId === r.id ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-start gap-1">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {titleField ? <Cell field={titleField} value={r.data[titleField.name]} /> : `#${r.id}`}
                          </span>
                          <RowActions canEdit={canEdit} canRemove={canRemove} onEdit={() => openEdit(r)} onRemove={() => remove(r)} size={12} />
                        </div>
                        <div className="mt-1.5 space-y-1">
                          {columns
                            .filter((f) => f.name !== titleField?.name && f.name !== groupByField.name)
                            .slice(0, 3)
                            .map((f) => (
                              <div key={f.name} className="flex items-center gap-1 text-xs text-stone-500">
                                <span className="shrink-0">{f.label}：</span>
                                <span className="min-w-0 flex-1 truncate">
                                  <Cell field={f} value={r.data[f.name]} />
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : blueprint.views.mode === 'cards' ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((r) => (
              <div key={r.id} className="al-card space-y-2.5 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 font-semibold">
                    {titleField ? <Cell field={titleField} value={r.data[titleField.name]} /> : `#${r.id}`}
                  </div>
                  <RowActions canEdit={canEdit} canRemove={canRemove} onEdit={() => openEdit(r)} onRemove={() => remove(r)} />
                </div>
                <dl className="space-y-1.5">
                  {columns
                    .filter((f) => f.name !== titleField?.name)
                    .map((f) => (
                      <div key={f.name} className="flex items-baseline gap-2 text-sm">
                        <dt className="w-20 shrink-0 text-xs text-stone-400">{f.label}</dt>
                        <dd className="min-w-0 flex-1">
                          <Cell field={f} value={r.data[f.name]} />
                        </dd>
                      </div>
                    ))}
                </dl>
              </div>
            ))}
          </div>
        ) : (
          <div className="al-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-left">
                    {columns.map((f) => (
                      <th key={f.name} className="whitespace-nowrap px-3 py-2.5 text-xs font-medium text-stone-500">
                        {f.label}
                      </th>
                    ))}
                    {(canEdit || canRemove) && <th className="w-20 px-3 py-2.5 text-xs font-medium text-stone-500">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/60">
                      {columns.map((f) => (
                        <td key={f.name} className="max-w-[240px] px-3 py-2.5 align-top">
                          <Cell field={f} value={r.data[f.name]} />
                        </td>
                      ))}
                      {(canEdit || canRemove) && (
                        <td className="px-3 py-2.5">
                          <RowActions canEdit={canEdit} canRemove={canRemove} onEdit={() => openEdit(r)} onRemove={() => remove(r)} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {formOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" onMouseDown={() => setFormOpen(false)}>
          <form className="al-card max-h-[85vh] w-full max-w-lg overflow-y-auto p-5" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold">{editing ? `编辑${entity}` : `新增${entity}`}</h3>
              <button type="button" onClick={() => setFormOpen(false)} className="text-stone-400 hover:text-stone-600">
                <X size={16} />
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {fields.map((f) => (
                <DynamicField
                  key={f.name}
                  field={f}
                  value={values[f.name]}
                  accent={blueprint.app.accent}
                  onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
                />
              ))}
            </div>
            {formError && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">{formError}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="al-btn-outline" onClick={() => setFormOpen(false)}>
                取消
              </button>
              <button type="submit" className="al-btn-primary" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
