import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ALLOWED_LIBS = ['todo', 'actionitems', 'pipeline', 'testgate', 'retro'];
export function loadStateLib(name) {
    if (!ALLOWED_LIBS.includes(name)) {
        throw new Error(`Unknown state-lib: ${name}`);
    }
    return require(`../state-lib/${name}.js`);
}
