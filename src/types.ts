/** Shared literal unions for the domain. */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalSide = 'DEBIT' | 'CREDIT';
export type AccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';
export type PeriodStatus = 'OPEN' | 'PRECLOSED' | 'CLOSED' | 'LOCKED';
export type TxType = 'TRANSFER' | 'FEE' | 'REFUND' | 'REVERSAL' | 'FX' | 'ADJUST';
