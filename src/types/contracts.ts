interface ContractGenesis {
  id: string //Random uuid

  code_url: string //IPFS CID
  stream_id: string //Stream ID of the manifest
  creators: string[] //list of DIDs that created the contract
}

interface ContractManifest {
  code_url: string //
  name: string //Arbitrary name of the contract. Not unique
}

export interface Contract {
  id: string
  name: string
  code: string
  stateMerkle?: string //V0 of contract state
  creation_tx?: string
  created_at?: Date
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

export interface ContractOutput {
  id: string //Calculated when created/signed
  contract_id: string
  included_in: string //Generated when being included into an Anchor Block
  inputs: Array<{
    id: string
  }>
  stateMerkle: string
  //log: JsonPatchOp[]
  //Matrix of subdocuments --> individual logs
  log_matrix: Record<
    string,
    {
      log: JsonPatchOp[]
    }
  >
}

export interface ContractOutputRaw {
    inputs: Array<{
      id: string
    }>
    state_merkle: string
    //log: JsonPatchOp[]
    //Matrix of subdocuments --> individual logs
    log_matrix: Record<
      string,
      {
        log: JsonPatchOp[]
      }
    >
  }
  
