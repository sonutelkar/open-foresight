import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type Prompt = {
  name: string; version: string;
  /** Names the file and its content, such as `designer@v1:3f9a0c12b7de`. Stored with every model call. */
  promptVersion: string;
  /** The full file hash, so a changed prompt is always visible. */
  sha256: string;
  system: string; user: string;
};

const safeName = /^[a-z][a-z0-9-]{0,40}$/;
const safeVersion = /^v[0-9]{1,3}$/;
const placeholder = /\{\{([a-z_]+)\}\}/g;

/** Loads `prompts/<name>/<version>.md`. The file has a `## System` section and a `## User` section. */
export function loadPrompt(name: string, version: string): Prompt {
  if (!safeName.test(name) || !safeVersion.test(version)) throw new Error('Invalid prompt name or version');
  const text = readFileSync(new URL(`../prompts/${name}/${version}.md`, import.meta.url), 'utf8');
  const systemAt = text.indexOf('\n## System\n');
  const userAt = text.indexOf('\n## User\n');
  if (systemAt < 0 || userAt < systemAt) throw new Error(`Prompt ${name}@${version} needs ## System then ## User`);
  const sha256 = createHash('sha256').update(text).digest('hex');
  return {
    name, version, promptVersion: `${name}@${version}:${sha256.slice(0, 12)}`, sha256,
    system: text.slice(systemAt + '\n## System\n'.length, userAt).trim(),
    user: text.slice(userAt + '\n## User\n'.length).trim(),
  };
}

/** Fills `{{name}}` placeholders. A missing or unused variable is an error, so a prompt can never go out half filled. */
export function render(template: string, vars: Record<string, string>): string {
  const used = new Set<string>();
  const out = template.replace(placeholder, (_, key: string) => {
    if (!(key in vars)) throw new Error(`Missing prompt variable: ${key}`);
    used.add(key);
    return vars[key] ?? '';
  });
  const unused = Object.keys(vars).filter(k => !used.has(k));
  if (unused.length) throw new Error(`Unused prompt variables: ${unused.join(', ')}`);
  return out;
}
