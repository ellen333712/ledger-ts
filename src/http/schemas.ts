import { z } from 'zod';
import { accountIdSchema, currencySchema } from '../engine/validate.js';

export const createAccountSchema = z.object({
  account_id: accountIdSchema,
  name: z.string().min(1).max(200),
  account_type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  normal_side: z.enum(['DEBIT', 'CREDIT']),
  currency: currencySchema,
  parent_id: accountIdSchema.optional(),
});
