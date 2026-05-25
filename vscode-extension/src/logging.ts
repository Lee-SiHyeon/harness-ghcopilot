import * as vscode from 'vscode';

export interface MaestroLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  show(): void;
}

function format(level: string, message: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const suffix = data === undefined ? '' : ' ' + safeStringify(data);
  return `[${ts}] [${level}] ${message}${suffix}`;
}

function safeStringify(data: unknown): string {
  try {
    if (data instanceof Error) {
      return JSON.stringify({ name: data.name, message: data.message, stack: data.stack });
    }
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function createLogger(output: vscode.OutputChannel): MaestroLogger {
  return {
    info(message, data) {
      output.appendLine(format('info', message, data));
    },
    warn(message, data) {
      output.appendLine(format('warn', message, data));
    },
    error(message, data) {
      output.appendLine(format('error', message, data));
    },
    show() {
      output.show(true);
    },
  };
}
