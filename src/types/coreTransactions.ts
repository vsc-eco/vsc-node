import { JsonPatchOp } from "./contracts";
import CID from 'cids'

export interface CoreBaseTransaction {
  action: string;
  net_id: string;
}

export interface Deposit extends CoreBaseTransaction {
  action: CoreTransactionTypes.deposit_to_contract | CoreTransactionTypes.deposit_to_account;  
  to?: string; // pla: deposit on someone elses behave
  contract_id?: string;
}

// pla: withdraws from the user safe
export interface Withdraw extends CoreBaseTransaction {
  action: CoreTransactionTypes.withdraw_from_account;
  amount: number;
}

export interface AnnounceBlock extends CoreBaseTransaction {
  action: CoreTransactionTypes.announce_block;
  block_hash: string;
}

export interface EnableWitness extends CoreBaseTransaction {
  action: CoreTransactionTypes.enable_witness;
  node_id: string;
}

export interface CreateContract extends CoreBaseTransaction {
  manifest_id: string;
  action: CoreTransactionTypes.create_contract;
  name: string; // pla: obsolete as its already contained in the manifest, correct?
  code: string;
}

export interface JoinContract extends CoreBaseTransaction {
  action: CoreTransactionTypes.join_contract;
  contract_id: string;
  node_identity: string;
  node_id: string;
}

export interface LeaveContract extends CoreBaseTransaction {
  action: CoreTransactionTypes.leave_contract;
  contract_id: string;
  node_identity: string;
  node_id: string;
}

export enum CoreTransactionTypes {
    announce_block = "announce_block",
    announce_leaf = "announce_leaf",
    enable_witness = "enable_witness",
    disable_witness = "disable_witness",
    allow_witness = "allow_witness",
    dissallow_witness = "dissallow_witness",
    enable_executor = "enable_executor",
    disable_executor = "disable_executor",
    create_contract = "create_contract",
    join_contract = "join_contract", //Joins a contract as an executor
    leave_contract = "leave_contract", //Leaves a contract as an executor
    deposit_to_contract = "deposit_to_contract",
    deposit_to_account = "deposit_to_account",
    withdraw_from_account = "withdraw_from_account",

    //Maybe? Not sure where it fits
    link_did = "link_did",
    unlink_did = "unlink_did"
}