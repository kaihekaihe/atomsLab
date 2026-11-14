import type { AppBlueprint, RecordData, ViewMode } from './types';

export const MODE_CN: Record<ViewMode, string> = { table: '表格', kanban: '看板', cards: '卡片' };

export interface StatValue {
  label: string;
  value: string;
}

/** 统计卡取值：count / sum / avg / ratio，按当前记录集在前端即时计算。 */
export function computeStats(bp: AppBlueprint, rows: RecordData[]): StatValue[] {
  return bp.stats.map((stat) => {
    const total = rows.length;
    if (stat.type === 'count') return { label: stat.label, value: String(total) };
    const values = rows
      .map((r) => r.data[stat.field ?? ''])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (stat.type === 'sum') {
      const sum = values.reduce((a, b) => a + b, 0);
      const field = bp.data.fields.find((f) => f.name === stat.field);
      return {
        label: stat.label,
        value: field?.display === 'currency' ? `¥${Math.round(sum).toLocaleString()}` : String(Math.round(sum * 10) / 10),
      };
    }
    if (stat.type === 'avg') {
      if (!values.length) return { label: stat.label, value: '—' };
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      return { label: stat.label, value: String(Math.round(avg * 10) / 10) };
    }
    const matched = rows.filter((r) => r.data[stat.whereField ?? ''] === stat.whereValue).length;
    return { label: stat.label, value: total ? `${Math.round((matched / total) * 100)}%` : '—' };
  });
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
