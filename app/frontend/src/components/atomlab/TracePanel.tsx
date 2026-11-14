import { Loader2 } from 'lucide-react';
import type { RunView, StepStatus } from '@/lib/atomlab/types';

const LABEL: Record<StepStatus, string> = { pending: '等待中', running: '执行中', done: '完成', failed: '失败', skipped: '跳过' };
const ICON_CLS: Record<StepStatus, string> = {
  pending: 'border-stone-200 text-stone-400',
  running: 'border-violet-300 text-violet-600',
  done: 'border-emerald-300 text-emerald-600',
  failed: 'border-rose-300 text-rose-600',
  skipped: 'border-stone-200 text-stone-400',
};
const SYMBOL: Record<StepStatus, string> = { pending: '○', running: '', done: '✓', failed: '✕', skipped: '—' };

/** 智能体轨迹：实时展示三个阶段的状态、耗时与说明（数据来自轮询接口）。 */
export function TracePanel({ trace }: { trace: RunView | null }) {
  if (!trace) {
    return (
      <div className="p-6 text-center text-xs leading-relaxed text-stone-400">
        还没有生成记录。
        <br />
        在「对话」里描述需求，这里会实时展示三个智能体的执行过程。
      </div>
    );
  }
  const { steps, run, result } = trace;
  return (
    <div className="h-full space-y-4 overflow-y-auto p-4">
      <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
        <div className="text-[10px] font-medium tracking-wide text-stone-400">本次需求</div>
        <div className="mt-1 text-xs leading-relaxed text-stone-700">{run.prompt}</div>
      </div>
      <div>
        {steps.map((s, i) => (
          <div key={s.agent} className="relative flex gap-3 pb-4">
            {i < steps.length - 1 && <span className="absolute left-[11px] top-6 h-full w-px bg-stone-200" />}
            <span className={`z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full border bg-white text-xs font-bold ${ICON_CLS[s.status]}`}>
              {s.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : SYMBOL[s.status]}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium">{s.title}</span>
                <span className="text-[10px] text-stone-400">
                  {LABEL[s.status]}
                  {typeof s.ms === 'number' && s.status !== 'pending' && s.status !== 'running' ? ` · ${(s.ms / 1000).toFixed(1)}s` : ''}
                </span>
              </div>
              {s.note && <p className={`mt-0.5 text-xs leading-relaxed ${s.status === 'failed' ? 'text-rose-500' : 'text-stone-500'}`}>{s.note}</p>}
            </div>
          </div>
        ))}
      </div>
      {run.status === 'failed' && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs leading-relaxed text-rose-600">
          任务失败：{run.error || '未知原因'}。可回到对话重试。
        </div>
      )}
      {run.status === 'done' && result && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
          <div className="flex items-center gap-2 font-medium">
            已生成 v{result.version}
            <span className={`al-badge border ${result.engine === 'agent' ? 'border-violet-200 bg-white text-violet-600' : 'border-amber-200 bg-white text-amber-700'}`}>
              engine: {result.engine}
            </span>
          </div>
          {result.diff.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              {result.diff.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
