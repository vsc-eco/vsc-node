export * from './contracts'

//Engrained into the blockchain for reference
export interface BlockRecord {
  __t: 'vsc-block'
  state_updates: Record<string, string>
  //txs
  txs: Array<{
    t: TransactionDbType
    op: string
    id: string
  }>

  previous?: any
  timestamp: Date | string
}

export interface TransactionContainer {
  id?: string //Created during signing
  __t: 'vsc-tx'
  __v: '0.1'
  lock_block: string
  included_in: string | null
  accessible?: boolean

  op: string
  payload: string
  type: TransactionDbType
}

export const CoreTransactionTypes = ['announce_node', 'create_contract']

export enum TransactionOps {
  createContract = 'create_contract',
  updateContract = 'update_contract',
  deleteContract = 'delete_contract',
  callContract = 'call_contract',
}

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

export interface TransactionRaw {
  op: string
  payload: any
}
