import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const ALLOWED_LIBS = ['todo', 'actionitems', 'pipeline', 'testgate', 'retro'] as const;

export function loadStateLib(name: string): any {
  if (!(ALLOWED_LIBS as readonly string[]).includes(name)) {
    throw new Error(`Unknown state-lib: ${name}`);
  }
  return require(`../state-lib/${name}.js`);
}
