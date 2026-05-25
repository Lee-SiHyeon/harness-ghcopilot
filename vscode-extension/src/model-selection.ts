export interface ModelCandidate {
  name: string;
  family: string;
  vendor: string;
}

interface RankedModel<T extends ModelCandidate> {
  model: T;
  index: number;
  score: number;
}

export function choosePreferredModel<T extends ModelCandidate>(models: T[]): T | undefined {
  if (models.length === 0) return undefined;
  return models
    .map((model, index): RankedModel<T> => ({ model, index, score: scoreModel(model) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)[0]?.model;
}

export function scoreModel(model: ModelCandidate): number {
  const text = `${model.family} ${model.name}`.toLowerCase();

  if (/\b(mini|nano|small|flash|haiku)\b/.test(text)) return 10;
  if (text.includes('gpt-4.1')) return 20;
  if (text.includes('gpt-4o')) return 25;
  if (text.includes('sonnet')) return 35;
  if (text.includes('gemini')) return 45;
  if (text.includes('opus')) return 90;

  return 50;
}
