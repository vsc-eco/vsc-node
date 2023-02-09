import { JsonPatchOp } from "./contracts";
import CID from 'cids'

export interface BaseTransaction {
  action: string;
  net_id: string;
}

export interface AnnounceBlock extends BaseTransaction {
  action: 'enable_witness';
  block_hash: string;
}

export interface EnableWitness extends BaseTransaction {
  action: 'announce_block';
  node_id: string;
}

export interface CreateContract extends BaseTransaction {
  manifest_id: string;
  action: 'create_contract';
  name: string; // pla: obsolete as its already contained in the manifest, correct?
  code: string;
}

export interface JoinContract extends BaseTransaction {
  action: 'join_contract';
  contract_id: string;
  node_identity: string;
  node_id: string;
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