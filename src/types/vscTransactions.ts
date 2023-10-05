import { CID } from "kubo-rpc-client"
import { JsonPatchOp } from "./contracts"

export interface CoreVSCTransaction {
    action: string;
}

export interface ContractInput extends CoreVSCTransaction {
    contract_id: string,
    action: VSCTransactionTypes.call_contract,
    payload: any,
    salt?: string
}
  
export interface ContractUpdate extends CoreVSCTransaction {
    action: VSCTransactionTypes.update_contract,
    // TBD
}
  
export interface ContractOutput extends CoreVSCTransaction {
    action: VSCTransactionTypes.contract_output,
    contract_id: string,
    parent_tx_id?: string,
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
    chain_actions: any | null
}

export interface TransactionContractLogMatrix {
    log: JsonPatchOp[]
}

export enum VSCTransactionTypes {
    call_contract = "call_contract",
    contract_output = "contract_output",
    update_contract = "update_contract",
    transferFunds = "transfer_funds",
}