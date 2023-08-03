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
  id: string; // the initial transaction id (may be a vsc or a hive tx id)
  orig_balance: number; // the original amount deposited
  active_balance: number; // the current amount of funds available for withdrawal
  created_at: Date;
  last_interacted_at: Date;
  controllers: Array<BalanceController>; // accounts that have permissions to operate on the deposit
  outputs: Array<string>; // ipfs links of transactions that operated on the deposit (withdraws, transfers)
  asset_type: string,
  created_lock: CreationLock,
  // state_hash: any; // hash of all prior transactions that led to the current active amount of funds for quick verification
  // controller_hash: string
}

export interface CreationLock {
  block_ref: string,
  expire_block: number,
  included_block: number 
}

export interface BalanceController {
  type: 'HIVE' | 'DID',
  authority: string
}

export interface ContractDeposit extends Deposit {
  contract_id: string;
}

export interface AccountDeposit extends Deposit {}

export interface BalanceUpdate {
  id: string, // hive tx id
  amount: number,
  created_at: Date;
  finalized: boolean; // pla: important property, when user requests a transfer/ withdraw it is not finalized yet. only after the assurance of the viability of the tx and the actual execution/ move of the funds this is updated
}

// pla: for transfers within the vsc network (contract to contract, vsc account to vsc account, contract to vsc account), still anchored as a core tx on hive
export interface Transfer extends BalanceUpdate {
  from_deposit_id?: string, // pla: if not supplied the user sends funds from the internal vsc account balance
  to_deposit_id?: string, // pla: if not supplied the user receives the funds on his internal vsc account balance

  // note: there will be checks that only either one of them can be undefined
}

// For withdraws FROM the multisig account TO a specified hive account, funds are always withdrawn from the user account that requests the withdraw
export interface Withdraw extends BalanceUpdate {
  account_id: string // hive account
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