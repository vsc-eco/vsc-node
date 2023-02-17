export * from './contracts'
export * from './transactions'

//Engrained into the blockchain for reference
export interface BlockRecord {
  __t: 'vsc-block'
  state_updates: Record<string, string>
  //txs
  txs: Array<TransactionBase>

  previous?: any
  timestamp: Date | string
}

export interface ContractInput {
  contract_id: string,
  action: string,
  payload: any
}

export interface ContractOutput {
  contract_id: string,
  updated_merkle: string
  // action: string,
  // payload: any
}

export interface TransactionContainer {
  id?: string //Created during signing
  __t: 'vsc-tx'
  __v: '0.1'
  lock_block: string
  included_in: string | null
  accessible?: boolean

  tx: TransactionRaw
  // op: string
  // payload: string
  // target_address?: string
  // type: TransactionDbType
}

export const CoreTransactionTypes = ['announce_node', 'create_contract']

export interface TransactionDbRecord {
  id: string
  account_auth: string
  op: string
  lock_block: string
  status: TransactionDbStatus
  local: boolean
  first_seen: Date
  type: TransactionDbType
  included_in: string | null
  executed_in: string | null
  output: string | null
}

export enum TransactionDbStatus {
  unconfirmed = 'UNCOFIRMED',
  confirmed = 'CONFIRMED',
  failed = 'FAILED',
  included = 'INCLUDED',
}

export enum TransactionDbType {
  null,
  input,
  output,
  virtual,
  core,
}

export interface BlockHeader {
  height: number
  id: string
}

export interface TransactionBase {
  op: string
  payload: any
}

export interface TransactionRaw extends TransactionBase {
  type: TransactionDbType
}

export enum VSCOperations {
  call_contract = "call_contract",
  contract_output = "contract_output",

  update_contract = "update_contract",
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