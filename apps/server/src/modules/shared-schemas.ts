import { z } from 'zod';

export const IdParams = z.object({ id: z.coerce.number().int().positive() });

export const MediaRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('remote'), path: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('library'), id: z.number().int().positive() }),
]);

export const booleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => value === 'true' || value === '1');
