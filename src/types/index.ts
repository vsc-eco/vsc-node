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
  prefix: string,
  level: string,
  printMetadata: boolean
}


export interface DidAuthRecord {
  account: string
  authority_type: "posting" | "active"
  valid_from: number
  valid_to: number | null
  tx_ref
}