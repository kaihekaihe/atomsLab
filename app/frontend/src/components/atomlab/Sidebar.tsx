import { useState, type FormEvent } from 'react';
import { Check, LogOut, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ProjectSummary } from '@/lib/atomlab/types';

interface SidebarProps {
  user: { email: string; name?: string };
  projects: ProjectSummary[];
  selectedId: number | null;
  running: boolean;
  onSelect: (id: number) => void;
  onCreate: (name: string) => void;
  onRename: (id: number, name: string) => void;
  onDelete: (id: number) => void;
  onLogout: () => void;
}

export function Sidebar({ user, projects, selectedId, running, onSelect, onCreate, onRename, onDelete, onLogout }: SidebarProps) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const display = user.name || user.email.split('@')[0] || '用户';

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.trim();
    if (!name) return;
    setCreating(false);
    setDraft('');
    onCreate(name);
  };

  const submitRename = (e: FormEvent) => {
    e.preventDefault();
    const name = renameDraft.trim();
    if (renamingId !== null && name) onRename(renamingId, name);
    setRenamingId(null);
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-slate-950 text-stone-300">
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white">A</div>
        <div>
          <div className="text-sm font-semibold text-white">AtomLab</div>
          <div className="text-[10px] tracking-wide text-stone-500">智能体应用工作台</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {creating ? (
          <form onSubmit={submitCreate} className="mb-2 flex gap-1.5">
            <input
              autoFocus
              className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-stone-500 focus:border-violet-500"
              placeholder="项目名，如 我的库存"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={40}
            />
            <button className="shrink-0 rounded-lg bg-violet-600 px-2.5 text-sm font-medium text-white hover:bg-violet-500">创建</button>
            <button type="button" className="shrink-0 rounded-lg px-1.5 text-stone-400 hover:bg-slate-800" onClick={() => setCreating(false)}>
              <X size={14} />
            </button>
          </form>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-700 py-2 text-sm text-stone-400 transition hover:border-violet-500 hover:text-violet-300"
          >
            <Plus size={14} /> 新建项目
          </button>
        )}

        <nav className="space-y-0.5">
          {projects.map((p) =>
            renamingId === p.id ? (
              <form key={p.id} onSubmit={submitRename} className="flex gap-1 rounded-lg bg-slate-800 p-1.5">
                <input
                  autoFocus
                  className="w-full min-w-0 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-white outline-none focus:border-violet-500"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  maxLength={40}
                />
                <button title="保存" className="px-1 text-emerald-400 hover:text-emerald-300">
                  <Check size={14} />
                </button>
                <button type="button" title="取消" className="px-1 text-stone-500 hover:text-stone-300" onClick={() => setRenamingId(null)}>
                  <X size={14} />
                </button>
              </form>
            ) : (
              <div key={p.id} className={`group flex items-center rounded-lg pr-1 ${p.id === selectedId ? 'bg-slate-800 text-white' : 'hover:bg-slate-900'}`}>
                <button onClick={() => onSelect(p.id)} className="min-w-0 flex-1 px-3 py-2 text-left">
                  <span className="block truncate text-sm">{p.name}</span>
                  <span className="block truncate text-[11px] text-stone-500">
                    {p.active_version ? `v${p.active_version}` : '未生成'} · {p.record_count} 条记录
                    {running && p.id === selectedId && <span className="text-violet-400"> · 生成中</span>}
                  </span>
                </button>
                <button
                  title="重命名"
                  onClick={() => {
                    setRenamingId(p.id);
                    setRenameDraft(p.name);
                  }}
                  className="shrink-0 px-1 text-stone-500 opacity-0 transition hover:text-white group-hover:opacity-100"
                >
                  <Pencil size={12} />
                </button>
                <button title="删除项目" onClick={() => onDelete(p.id)} className="shrink-0 px-1 text-stone-500 opacity-0 transition hover:text-rose-400 group-hover:opacity-100">
                  <Trash2 size={13} />
                </button>
              </div>
            ),
          )}
          {projects.length === 0 && (
            <div className="px-3 py-6 text-center text-xs leading-relaxed text-stone-500">
              还没有项目
              <br />
              点击上方新建一个吧
            </div>
          )}
        </nav>
      </div>

      <div className="border-t border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-700 text-xs font-semibold text-white">{display.slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-stone-200">{display}</div>
            <div className="truncate text-[11px] text-stone-500">{user.email}</div>
          </div>
          <button title="退出登录" onClick={onLogout} className="shrink-0 text-stone-400 hover:text-white">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
