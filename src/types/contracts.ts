interface ContractGenesis {
  id: string //Random uuid

  code_url: string //IPFS CID
  stream_id: string //Stream ID of the manifest
  creators: string[] //list of DIDs that created the contract
}

export interface ContractManifest {
  name: string; //None unique name of the contract
  description: string; //None unique description of the contract
  controllers: string[]; //List of DIDs that have update permission over the control
  code: string;
  lock_block: string;
}

export interface Contract {
  id: string // creation_tx
  manifest_id: string // the CID of the manifest
  name: string // pla: obsolete as its already contained in the manifest, correct?
  code: string
  state_merkle?: string //V0 of contract state
  creation_tx?: string
  created_at?: Date,
  balanceTransactions?: string[] //List of transaction ids that have affected the balance of the contract
}

export interface ContractCommitment {
  id: string // creation_tx
  creation_tx: string
  contract_id: string
  node_id: string
  node_identity: string
  created_at: Date
  status: CommitmentStatus
  latest_state_merkle: string
  latest_update_date: Date
  last_pinged: Date
  pinged_state_merkle: string
}

export interface JsonPatchOp {
  op: string
  path: string
  value: string | object | number
}

//TBD. Define entry points that the contract can interact with
interface EntryPoints {}

interface CoreState {
  stateMap: string //IPFS URL to map of all state variables
}

export enum CommitmentStatus {
  inactive,
  active
}

export enum InputHeaderFlags {
  INDEX_SEARCH = "index_search"
}

export interface InputHeader {
  flags: Array<InputHeaderFlags>
  sender: {
    id: string
    type: "HIVE" | "DID"
  }
}