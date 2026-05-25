import * as vscode from 'vscode';

export interface RuntimeModelInfo {
  name: string;
  vendor: string;
  family: string;
}

export interface RuntimeGithubAuthInfo {
  providerId: string;
  accountLabel?: string;
  accountId?: string;
  accountCount?: number;
  hasSession: boolean;
  error?: string;
  updatedAt: string;
}

export interface RuntimeSnapshot {
  sessionId?: string;
  executorMode?: string;
  intent?: string;
  pipeline?: string[];
  promptChars?: number;
  selectedModel?: RuntimeModelInfo;
  selectedModelSource?: string;
  chatUiModel?: RuntimeModelInfo;
  githubAuth?: RuntimeGithubAuthInfo;
  updatedAt?: string;
}

let snapshot: RuntimeSnapshot = {};
const onDidChangeEmitter = new vscode.EventEmitter<RuntimeSnapshot>();

export const onDidChangeRuntimeSnapshot = onDidChangeEmitter.event;

export function updateRuntimeSnapshot(patch: Partial<RuntimeSnapshot>): void {
  snapshot = {
    ...snapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  onDidChangeEmitter.fire(getRuntimeSnapshot());
}

export function getRuntimeSnapshot(): RuntimeSnapshot {
  return { ...snapshot, pipeline: snapshot.pipeline ? [...snapshot.pipeline] : undefined };
}

export function modelInfo(model: vscode.LanguageModelChat | undefined): RuntimeModelInfo | undefined {
  if (!model) return undefined;
  return {
    name: model.name,
    vendor: model.vendor,
    family: model.family,
  };
}
