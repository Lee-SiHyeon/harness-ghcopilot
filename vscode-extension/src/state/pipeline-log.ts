import * as fs from 'fs';
import { HarnessPaths } from './paths';

export interface PipelineLogEntry {
  pipeline_id?: string;
  step: string;
  output?: string;
  extra?: Record<string, unknown>;
}

const PIPELINE_NAME = 'pipeline.jsonl';

export function appendPipelineStep(paths: HarnessPaths, entry: PipelineLogEntry): void {
  try {
    fs.mkdirSync(paths.logsDir, { recursive: true });
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      pipeline_id: entry.pipeline_id,
      step: entry.step,
      output: entry.output ?? '',
      ...(entry.extra || {}),
    };
    fs.appendFileSync(paths.log(PIPELINE_NAME), JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* never fail the pipeline because of logging */
  }
}
