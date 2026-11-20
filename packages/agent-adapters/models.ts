import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { reasoningEffortSchema, type ModelCatalog } from '../shared/models.ts';

const cacheSchema = z.object({
  models: z
    .array(
      z.object({
        slug: z.string().min(1).max(200),
        display_name: z.string().max(200).optional(),
        visibility: z.string().optional(),
        supported_reasoning_levels: z.array(z.object({ effort: z.string() })).default([]),
      }),
    )
    .max(256),
});
export async function modelCatalog(
  cachePath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'models_cache.json'),
): Promise<ModelCatalog> {
  const result: ModelCatalog = {
    codex: [],
    claude: ['sonnet', 'opus', 'fable'].map((id) => ({ id, label: id, efforts: [] })),
    codexSource: 'unavailable',
  };
  try {
    const text = await readFile(cachePath, 'utf8');
    if (text.length > 2 * 1024 * 1024) return result;
    const cache = cacheSchema.parse(JSON.parse(text));
    result.codex = cache.models
      .filter((model) => model.visibility === 'list')
      .map((model) => ({
        id: model.slug,
        label: model.display_name ?? model.slug,
        efforts: model.supported_reasoning_levels.flatMap((level) => {
          const parsed = reasoningEffortSchema.safeParse(level.effort);
          return parsed.success ? [parsed.data] : [];
        }),
      }));
    result.codexSource = 'local-cache';
  } catch {
    return result;
  }
  return result;
}
