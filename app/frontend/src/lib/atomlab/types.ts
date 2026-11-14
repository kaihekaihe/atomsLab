// 与后端 services/blueprint.py、routers/atomlab.py 的响应结构保持一致。

export type FieldKind = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'boolean';
export type ViewMode = 'table' | 'kanban' | 'cards';
export type StatType = 'count' | 'sum' | 'avg' | 'ratio';

export interface AppField {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  options?: string[];
  hint?: string;
  display?: 'currency' | 'percent';
}

export interface StatDef {
  label: string;
  type: StatType;
  field?: string;
  whereField?: string;
  whereValue?: string;
}

export interface AppBlueprint {
  app: { name: string; tagline: string; icon: string; accent: string };
  data: { entity: string; fields: AppField[] };
  views: { mode: ViewMode; columns: string[]; groupBy?: string };
  actions: { create: boolean; update: boolean; remove: boolean };
  stats: StatDef[];
  seed: Record<string, unknown>[];
}

export interface RecordData {
  id: number;
  data: Record<string, unknown>;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ProjectSummary {
  id: number;
  name: string;
  description: string;
  active_version: number | null;
  record_count: number;
}

export interface VersionInfo {
  id: number;
  version: number;
  engine: string;
  source_prompt: string;
  created_at: string | null;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface RunStepView {
  seq: number;
  agent: string;
  title: string;
  status: StepStatus;
  ms?: number;
  note?: string;
}

export interface RunView {
  run: {
    id: number;
    prompt: string;
    status: string;
    error: string;
    engine: string;
    created_at: string | null;
    updated_at: string | null;
  };
  steps: RunStepView[];
  result: {
    version: number;
    engine: string;
    blueprint: AppBlueprint | null;
    diff: string[];
  } | null;
}

export interface RunBrief {
  id: number;
  prompt: string;
  status: string;
  error: string;
  engine: string;
  steps: RunStepView[];
  created_at: string | null;
}

export interface ProjectDetail {
  project: {
    id: number;
    name: string;
    description: string;
    created_at: string | null;
    active_version: number | null;
  };
  blueprint: AppBlueprint | null;
  versions: VersionInfo[];
  runs: RunBrief[];
  shareToken: string | null;
  records: RecordData[];
}

export interface ShareView {
  project: { name: string };
  blueprint: AppBlueprint;
  records: RecordData[];
}
