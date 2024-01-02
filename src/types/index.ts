// import { ContractOutputRaw } from './contracts'

export * from './contracts'

//Engrained into the blockchain for reference
export interface BlockRecord {
  __t: 'vsc-block'
  __v: '0.1'
  state_updates: Record<string, string>
  //txs
  txs: Array<TransactionConfirmed>

  previous?: any
  timestamp: Date | string
}

// this interface is used for deposits to a contract and to a users personal balance (safe)
export interface Deposit {
  from: string; // the account id that the funds are coming from
  id: string; // the initial transaction id (hive tx id if the deposit is from hive, vsc tx id if the deposit is a transfer from another contract)
  orig_balance: number; // the original amount deposited
  active_balance: number; // the current amount of funds available for withdrawal
  created_at: Date;
  last_interacted_at: Date;
  outputs: Array<DepositDrain>; // when balance leaves the deposit, either via internal vsc transfer or hive withdraw request, the tx id is added here
  inputs: Array<DepositDrain>; // when balance not directly comes from a hive tx, but an internal transfer it is a sum of different deposit (ids), in that case they are added here
  asset_type: string;
  create_block: BlockRef;
  controllers: Array<BalanceController>;
  contract_id?: string;
  controllers_hash: string;
}

export interface BlockRef {
  block_ref?: string,
  included_block: number 
}

export interface BalanceController {
  type: 'HIVE' | 'DID' | 'CONTRACT',
  authority: string,
  conditions: Array<BalanceAccessCondition>
}

export interface BalanceAccessCondition {
  type: 'TIME' | 'HASH' | 'WITHDRAW',
  value: string
}

export interface TimeLock extends BalanceAccessCondition {
  type: 'TIME',
  lock_applied: BlockRef,
  expiration_block: number
}

export interface HashLock extends BalanceAccessCondition {
  type: 'HASH',
  hash: string,
}

export interface WithdrawLock extends BalanceAccessCondition {
  type: 'WITHDRAW',
  expiration_block: number
}

export interface DepositDrain {
  deposit_id: string,
  amount: number
}

export interface DepositDrain {
  deposit_id: string,
  amount: number
}

export interface TransactionContainer {
  id?: string //Created during signing
  __t: 'vsc-tx'
  __v: '0.1'
  lock_block: string
  included_in?: string | null
  accessible?: boolean
  tx: TransactionRaw
}

export interface TransactionDbRecord {
  id: string
  account_auth: string
  op: string
  lock_block: string | null
  status: TransactionDbStatus
  first_seen: Date
  type: TransactionDbType
  included_in: string | null
  executed_in: string | null
  output: string | null
  
  local: boolean
  accessible: boolean

  headers: Record<string, any>
  output_actions?: any
}

export enum TransactionDbStatus {
  unconfirmed = 'UNCONFIRMED',
  confirmed = 'CONFIRMED',
  failed = 'FAILED',
  included = 'INCLUDED',
  processed = 'PROCESSED' // pla: temporary state until official confirmation from block parsing
}

export enum TransactionDbType {
  null,
  input,
  output,
  virtual,
  core,
}

export interface BlockHeader {
  hive_ref_block: number
  hive_ref_tx: string
  hive_ref_date: Date
  height: number
  id: string
}

export interface TransactionConfirmed {
  op: string
  id: string // cid of transactionRaw
  type: TransactionDbType
}

export interface TransactionRaw {
  op: string
  payload: any // cid of ContractInput, ContractOutput or ContractUpdate and so on..
  type: TransactionDbType
}

export enum NodeStorageType {
  //Stores complete state copies at every block rather than most recent state copy.
  verbose = "verbose",
  //Stores all state from all contracts and transactions. (historical transactions/outputs and current state only)
  //Useful for backup nodes or service providers wanting to keep copies of all contracts
  archive = "archive",
  //Stores state from only pinned smart contracts
  light = "light"
}

export interface LoggerConfig {
  prefix?: string,
  level?: string,
  printMetadata?: boolean
}

enum authType {
  "posting" = 'posting',
  "active" = 'posting'
}

//Onchain link giving DID X authority
export interface DidAuth {
  [did: string]: {
    ats: authType[]
    memo?: string
  }
}

export interface DidAuthRecord {
  account: string
  did: string
  authority_type: authType[]
  valid_from: number
  valid_to: number | null
  tx_ref
}