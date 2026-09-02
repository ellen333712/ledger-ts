/** Public API: the engine without HTTP. */
export { Ledger } from './engine/ledger.js';
export { openDb, migrate, type LedgerDb, type OpenedDb } from './db/open.js';
export { postTransaction, semanticPayloadHash, DEFAULT_POLICY, type PostPolicy } from './engine/post.js';
export { OutboxRelay, type OutboxEvent, type RelayOptions } from './engine/outbox.js';
export { reconcile, replayBalances, type ReconcileReport } from './engine/recon.js';
export { trialBalance, listEntries, getBalance, getTransaction } from './engine/query.js';
export { createAccount, getAccount, listAccounts, setAccountStatus, type CreateAccountInput } from './engine/accounts.js';
export { reverseTransaction, type ReverseInput } from './engine/reverse.js';
export { openPeriod, setPeriodStatus, listPeriods } from './engine/periods.js';
export { parseAmount, formatAmount, SCALE } from './money.js';
export { payloadHash, canonicalJson } from './canonical.js';
export {
  LedgerError,
  periodKeyFor,
  isPeriodKey,
  type LedgerErrorCode,
  type LedgerAccount,
  type LedgerTransaction,
  type LedgerEntry,
  type AccountBalance,
  type PostTransactionRequest,
  type PostTransactionResult,
} from './domain.js';
export type { AccountType, NormalSide, PeriodStatus, TxType } from './types.js';
