import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Download, Link2Off, Loader2, LogIn, Menu, MessageSquare, Share2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { atomlab, downloadText } from '@/lib/atomlab/api';
import type { ProjectDetail, ProjectSummary, RunBrief, RunView } from '@/lib/atomlab/types';
import { AppCanvas } from '@/components/atomlab/AppCanvas';
import { ChatPanel, type ChatMessage } from '@/components/atomlab/ChatPanel';
import { Sidebar } from '@/components/atomlab/Sidebar';
import { TracePanel } from '@/components/atomlab/TracePanel';
import { VersionsPanel } from '@/components/atomlab/VersionsPanel';

type Tab = 'chat' | 'trace' | 'versions';
const TABS: { key: Tab; label: string }[] = [
  { key: 'chat', label: '对话' },
  { key: 'trace', label: '智能体' },
  { key: 'versions', label: '版本' },
];
const POLL_MS = 1200;

function chatFromRuns(runs: RunBrief[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of runs) {
    out.push({ id: `u${r.id}`, role: 'user', text: r.prompt, time: r.created_at });
    if (r.status === 'done') {
      const note = r.steps.find((s) => s.agent === 'analyst')?.note || '已生成新版本';
      out.push({ id: `a${r.id}`, role: 'agent', text: note, time: r.created_at, engine: r.engine || 'agent' });
    } else if (r.status === 'failed') {
      out.push({ id: `a${r.id}`, role: 'agent', text: `生成失败：${r.error || '未知原因'}。历史版本未受影响，可调整后重试。`, time: r.created_at, failed: true });
    }
  }
  return out;
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-stone-100 p-6">
      <div className="al-card w-full max-w-sm p-8 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-lg font-bold text-white">A</div>
        <h1 className="mt-4 text-xl font-semibold text-stone-900">AtomLab 智能体应用工作台</h1>
        <p className="mt-2 text-sm leading-relaxed text-stone-500">一句话描述业务需求，三个智能体接力生成可增删改查的应用。登录或注册后开始使用，数据按账号隔离保存。</p>
        <button className="al-btn-primary mt-6 w-full justify-center py-2.5" onClick={onLogin}>
          <LogIn size={15} /> 登录 / 注册
        </button>
      </div>
    </div>
  );
}

export default function Studio() {
  const { user, loading: authLoading, login, logout } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [trace, setTrace] = useState<RunView | null>(null);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [loadError, setLoadError] = useState('');

  const running = activeRunId !== null;
  const blueprint = detail?.blueprint ?? null;
  const records = detail?.records ?? [];
  const activeVersion = detail?.project.active_version ?? null;
  const shareToken = detail?.shareToken ?? null;
  const chat = useMemo(() => chatFromRuns(detail?.runs ?? []), [detail]);

  const loadProjects = useCallback(async () => {
    try {
      const data = await atomlab.listProjects();
      setProjects(data.projects);
      setLoadError('');
      return data.projects;
    } catch (e) {
      setLoadError((e as Error).message);
      return [];
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    try {
      const data = await atomlab.getProject(id);
      setDetail(data);
      const pending = [...data.runs].reverse().find((r) => r.status === 'running');
      if (pending) {
        setActiveRunId(pending.id);
        setTab('trace');
      }
      return data;
    } catch (e) {
      toast.error((e as Error).message);
      setDetail(null);
      return null;
    }
  }, []);

  const selectProject = useCallback(
    (id: number) => {
      setProjectId(id);
      setTrace(null);
      setActiveRunId(null);
      setLeftOpen(false);
      void loadDetail(id);
    },
    [loadDetail],
  );

  useEffect(() => {
    if (!user) return;
    void (async () => {
      const list = await loadProjects();
      if (list.length) selectProject(list[0].id);
    })();
  }, [user, loadProjects, selectProject]);

  // 轮询生成任务：每阶段状态实时展示，完成后刷新项目
  useEffect(() => {
    if (activeRunId === null) return;
    let stopped = false;
    const tick = async () => {
      try {
        const data = await atomlab.getRun(activeRunId);
        if (stopped) return;
        setTrace(data);
        if (data.run.status !== 'running') {
          stopped = true;
          setActiveRunId(null);
          if (data.run.status === 'done') {
            toast.success(`已生成 v${data.result?.version ?? ''}（${data.result?.engine === 'agent' ? '智能体流水线' : '本地规则引擎'}）`);
          } else {
            toast.error('生成失败，已保留历史版本');
          }
          if (projectId) {
            await loadDetail(projectId);
            await loadProjects();
          }
        }
      } catch {
        // 网络抖动时继续轮询
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      if (!stopped) void tick();
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, projectId, loadDetail, loadProjects]);

  const send = async (text: string) => {
    if (!projectId || running) return;
    setTab('trace');
    try {
      const data = await atomlab.generate(projectId, text);
      setTrace({
        run: { id: data.runId, prompt: text, status: 'running', error: '', engine: '', created_at: null, updated_at: null },
        steps: [
          { seq: 1, agent: 'analyst', title: '需求分析师', status: 'pending' },
          { seq: 2, agent: 'architect', title: '应用架构师', status: 'pending' },
          { seq: 3, agent: 'inspector', title: '蓝图质检员', status: 'pending' },
        ],
        result: null,
      });
      setActiveRunId(data.runId);
    } catch (e) {
      toast.error((e as Error).message);
      setTab('chat');
    }
  };

  const createProject = async (name: string) => {
    try {
      const data = await atomlab.createProject(name);
      await loadProjects();
      selectProject(data.project.id);
      setTab('chat');
      toast.success('项目已创建，描述需求开始生成');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const renameProject = async (id: number, name: string) => {
    try {
      await atomlab.renameProject(id, name);
      await loadProjects();
      if (id === projectId) await loadDetail(id);
      toast.success('已重命名');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const removeProject = async (id: number) => {
    if (!window.confirm('确定删除该项目？所有蓝图版本与数据都会清除。')) return;
    try {
      await atomlab.deleteProject(id);
      const list = await loadProjects();
      if (projectId === id) {
        if (list.length) selectProject(list[0].id);
        else {
          setProjectId(null);
          setDetail(null);
        }
      }
      toast.success('项目已删除');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const shareUrl = shareToken ? `${window.location.origin}/share/${shareToken}` : '';

  const publish = async () => {
    if (!projectId) return;
    setPublishing(true);
    try {
      const data = await atomlab.publish(projectId);
      setDetail((cur) => (cur ? { ...cur, shareToken: data.token } : cur));
      await navigator.clipboard?.writeText(`${window.location.origin}/share/${data.token}`).catch(() => undefined);
      toast.success('已发布，分享链接已复制');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('分享链接已复制');
    } catch {
      window.prompt('复制分享链接', shareUrl);
    }
  };

  const unpublish = async () => {
    if (!projectId || !window.confirm('取消发布后旧链接将失效，确定吗？')) return;
    try {
      await atomlab.unpublish(projectId);
      setDetail((cur) => (cur ? { ...cur, shareToken: null } : cur));
      toast.success('已取消发布');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const exportCsv = async () => {
    if (!projectId) return;
    try {
      const data = await atomlab.exportCsv(projectId);
      downloadText(data.filename, data.csv);
      toast.success(`已导出 ${data.count} 条记录`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const restore = async (vid: number) => {
    if (!projectId) return;
    setRestoringId(vid);
    try {
      const data = await atomlab.restoreVersion(projectId, vid);
      await loadDetail(projectId);
      await loadProjects();
      toast.success(`已恢复并创建 v${data.version}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRestoringId(null);
    }
  };

  const createRecord = async (values: Record<string, unknown>) => {
    if (!projectId) return;
    const data = await atomlab.createRecord(projectId, values);
    setDetail((cur) => (cur ? { ...cur, records: [...cur.records, data.record] } : cur));
    void loadProjects();
    toast.success('已保存');
  };

  const updateRecord = async (id: number, values: Record<string, unknown>) => {
    if (!projectId) return;
    const data = await atomlab.updateRecord(projectId, id, values);
    setDetail((cur) => (cur ? { ...cur, records: cur.records.map((r) => (r.id === id ? data.record : r)) } : cur));
    toast.success('已保存');
  };

  const moveRecord = async (id: number, partial: Record<string, unknown>) => {
    try {
      await updateRecord(id, partial);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const removeRecord = async (id: number) => {
    if (!projectId) return;
    try {
      await atomlab.deleteRecord(projectId, id);
      setDetail((cur) => (cur ? { ...cur, records: cur.records.filter((r) => r.id !== id) } : cur));
      void loadProjects();
      toast.success('已删除');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (authLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-stone-100 text-sm text-stone-500">
        <span className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" /> 正在验证登录状态…
        </span>
      </div>
    );
  }
  if (!user) return <LoginScreen onLogin={login} />;

  const currentStep = trace?.steps.find((s) => s.status === 'running')?.title;

  return (
    <div className="flex h-screen overflow-hidden bg-stone-100 text-stone-800">
      <div className={`${leftOpen ? 'fixed inset-y-0 left-0 z-50 flex' : 'hidden'} lg:static lg:flex`}>
        <Sidebar
          user={user}
          projects={projects}
          selectedId={projectId}
          running={running}
          onSelect={selectProject}
          onCreate={createProject}
          onRename={renameProject}
          onDelete={removeProject}
          onLogout={logout}
        />
      </div>
      {leftOpen && <div className="fixed inset-0 z-40 bg-slate-950/30 lg:hidden" onClick={() => setLeftOpen(false)} />}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-stone-200 bg-white px-4">
          <button className="al-btn-ghost px-2 lg:hidden" title="项目" onClick={() => setLeftOpen(true)}>
            <Menu size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-semibold text-stone-900">{detail?.project.name ?? 'AtomLab'}</h1>
              {activeVersion !== null && <span className="al-badge shrink-0 border border-violet-200 bg-violet-50 text-violet-600">v{activeVersion}</span>}
              {running && (
                <span className="flex shrink-0 items-center gap-1 text-xs text-violet-600">
                  <Loader2 size={12} className="animate-spin" /> 生成中
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {shareToken ? (
              <>
                <button className="al-btn-outline py-1.5 text-xs" onClick={copyShare}>
                  <Copy size={13} /> 复制分享链接
                </button>
                <button className="al-btn-ghost px-2 py-1.5 text-stone-500" title="取消发布" onClick={unpublish}>
                  <Link2Off size={14} />
                </button>
              </>
            ) : (
              <button className="al-btn-outline py-1.5 text-xs" disabled={!blueprint || running || publishing} onClick={publish}>
                <Share2 size={13} /> {publishing ? '发布中…' : '发布分享'}
              </button>
            )}
            <button className="al-btn-outline py-1.5 text-xs" disabled={!blueprint} onClick={exportCsv}>
              <Download size={13} /> 导出 CSV
            </button>
            <button className="al-btn-ghost px-2 py-1.5 text-stone-500 lg:hidden" title="对话" onClick={() => setRightOpen(true)}>
              <MessageSquare size={16} />
            </button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1">
          <section className="min-w-0 flex-1">
            {!projectId ? (
              <div className="grid h-full place-items-center p-8">
                <div className="max-w-sm text-center">
                  <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-white text-3xl shadow-sm">📁</div>
                  <h2 className="mt-5 text-lg font-semibold">{loadError ? '项目加载失败' : '先新建一个项目'}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-stone-500">{loadError || '在左侧点击「新建项目」，再用一句话描述你想要的业务应用。'}</p>
                  {loadError && (
                    <button className="al-btn-outline mt-4" onClick={() => void loadProjects()}>
                      重试
                    </button>
                  )}
                </div>
              </div>
            ) : blueprint ? (
              <AppCanvas
                blueprint={blueprint}
                records={records}
                onCreate={createRecord}
                onEdit={updateRecord}
                onDelete={removeRecord}
                onMove={moveRecord}
              />
            ) : (
              <div className="grid h-full place-items-center p-8">
                <div className="max-w-sm text-center">
                  <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-white text-3xl shadow-sm">🏗️</div>
                  <h2 className="mt-5 text-lg font-semibold">{running ? '三个智能体正在为你搭建应用' : '这里还空着'}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-stone-500">
                    {running
                      ? `当前阶段：${currentStep ?? '启动中'}`
                      : '在右侧「对话」里用一句话描述你想要的业务应用，需求分析师、应用架构师和蓝图质检员会接力把它变成可运行的界面。'}
                  </p>
                </div>
              </div>
            )}
          </section>

          <aside
            className={`${rightOpen ? 'flex' : 'hidden lg:flex'} fixed inset-y-0 right-0 z-40 w-[min(92vw,380px)] flex-col border-l border-stone-200 bg-white shadow-2xl lg:static lg:z-auto lg:w-[380px] lg:shadow-none`}
          >
            <div className="flex shrink-0 items-center border-b border-stone-200">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`relative flex-1 py-2.5 text-sm font-medium transition ${tab === t.key ? 'text-violet-600' : 'text-stone-500 hover:text-stone-700'}`}
                >
                  {t.label}
                  {t.key === 'versions' && detail?.versions.length ? <span className="ml-1 text-[10px] text-stone-400">{detail.versions.length}</span> : null}
                  {t.key === 'trace' && running && <span className="absolute right-4 top-2.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />}
                  {tab === t.key && <span className="absolute inset-x-6 -bottom-px h-0.5 rounded-full bg-violet-600" />}
                </button>
              ))}
              <button className="px-3 text-stone-400 hover:text-stone-600 lg:hidden" onClick={() => setRightOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {tab === 'chat' &&
                (projectId ? (
                  <ChatPanel messages={chat} running={running} onSend={send} />
                ) : (
                  <div className="p-6 text-center text-xs text-stone-400">请先新建或选择一个项目。</div>
                ))}
              {tab === 'trace' && <TracePanel trace={trace} />}
              {tab === 'versions' && (
                <VersionsPanel
                  versions={detail?.versions ?? []}
                  activeVersion={activeVersion}
                  restoringId={restoringId}
                  disabled={running}
                  onRestore={restore}
                />
              )}
            </div>
          </aside>
          {rightOpen && <div className="absolute inset-0 z-30 bg-slate-950/30 lg:hidden" onClick={() => setRightOpen(false)} />}
        </div>
      </div>
    </div>
  );
}
