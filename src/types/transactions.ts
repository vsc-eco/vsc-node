import { JsonPatchOp } from "./contracts";
import CID from 'cids'

export interface AnnounceBlock {
    block_hash: string;
    net_id: string;
}

export interface EnableWitness {
    action: 'enable_witness';
    node_id: string;
    net_id: string;
}

export interface CreateContract {
  action: 'create_contract';
  id: string;
  name: string;
  code: string; 
  state_merkle: string;
}

export interface TransactionContractOutput {
    __t: "vsc.transaction_output"
    id: string //Calculated when created/signed
    contract_id: string
    //Generated when being included into an Anchor Block
    //This might be only for the DB, serialized format might not contain this
    included_in: string 
    //List of input transactions to this contract
    inputs: Array<{
      id: CID
    }>
    //State root of entire contract
    stateMerkle: CID
    //log: JsonPatchOp[]
    //Matrix of subdocuments --> individual logs
    log_matrix: Record<
      string,
      {
        link: CID
      }
    >
}

export interface TransactionContractLogMatrix {
    log: JsonPatchOp[]
}


export enum TransactionTypes {
    announce_block = "announce_block",
    announce_leaf = "announce_leaf",
    enable_witness = "enable_witness",
    disable_witness = "disable_witness",
    enable_executor = "enable_executor",
    disable_executor = "disable_executor",
    create_contract = "create_contract",
    call_contract = "call_contract",

    //Experimental contract relevant calls
    join_contract = "join_contract", //Joins a contract as an executor
    leave_contract = "leave_contract", //Leaves a contract as an executor

    //Maybe? Not sure where it fits
    link_did = "link_did",
    unlink_did = "unlink_did"
}