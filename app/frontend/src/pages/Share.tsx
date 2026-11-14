import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { atomlab } from '@/lib/atomlab/api';
import type { ShareView } from '@/lib/atomlab/types';
import { AppCanvas } from '@/components/atomlab/AppCanvas';

/** 免登录只读分享页：凭随机 token 读取已发布应用。 */
export default function Share() {
  const { token = '' } = useParams();
  const [data, setData] = useState<ShareView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    atomlab
      .readShare(token)
      .then((res) => alive && setData(res))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [token]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center bg-stone-100 p-6 text-center">
        <div>
          <div className="text-3xl">🔗</div>
          <h1 className="mt-3 font-semibold text-stone-800">无法打开分享</h1>
          <p className="mt-1 text-sm text-stone-500">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid min-h-screen place-items-center bg-stone-100 text-sm text-stone-500">
        <span className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" /> 加载中…
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-screen flex-col bg-stone-100 text-stone-800">
      <div className="shrink-0 bg-slate-950 px-4 py-2 text-center text-xs text-stone-300">
        「{data.project.name}」只读分享 · 由 AtomLab 生成
      </div>
      <div className="min-h-0 flex-1">
        <AppCanvas blueprint={data.blueprint} records={data.records} readOnly />
      </div>
    </div>
  );
}
