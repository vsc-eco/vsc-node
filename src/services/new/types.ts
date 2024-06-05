import type {
  AccountCreateOperation,
  AccountCreateWithDelegationOperation,
  AccountUpdateOperation,
  AccountWitnessProxyOperation,
  AccountWitnessVoteOperation,
  CancelTransferFromSavingsOperation,
  ChangeRecoveryAccountOperation,
  ClaimRewardBalanceOperation,
  ClaimAccountOperation,
  CommentOperation,
  CommentOptionsOperation,
  ConvertOperation,
  CreateClaimedAccountOperation,
  CustomOperation,
  CustomBinaryOperation,
  CustomJsonOperation,
  DeclineVotingRightsOperation,
  DelegateVestingSharesOperation,
  DeleteCommentOperation,
  EscrowApproveOperation,
  EscrowDisputeOperation,
  EscrowReleaseOperation,
  EscrowTransferOperation,
  FeedPublishOperation,
  LimitOrderCancelOperation,
  LimitOrderCreateOperation,
  LimitOrderCreate2Operation,
  PowOperation,
  Pow2Operation,
  RecoverAccountOperation,
  ReportOverProductionOperation,
  RequestAccountRecoveryOperation,
  ResetAccountOperation,
  SetResetAccountOperation,
  SetWithdrawVestingRouteOperation,
  TransferOperation,
  TransferFromSavingsOperation,
  TransferToSavingsOperation,
  TransferToVestingOperation,
  VoteOperation,
  WithdrawVestingOperation,
  WitnessUpdateOperation,
  WitnessSetPropertiesOperation,
  AccountUpdate2Operation,
  CreateProposalOperation,
  UpdateProposalVotesOperation,
  RemoveProposalOperation,
  UpdateProposalOperation,
  CollateralizedConvertOperation,
  RecurrentTransferOperation,
} from "@hiveio/dhive";

import { CID } from "kubo-rpc-client/dist/src"


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
    anchor_ref,
}

export interface BlockHeader extends VSCSignedData {
    anchor_chains: {
        'hive:mainet': {
            //ref_anchor_pos: 79976520
            ref_anchor_block: number
            ref_anchor_start: number
        }
    }

    // block: CID
    previous: CID

    block: CID
}

interface BlockContent {
    anchor_chains: {
        "hive:mainet": {
            ref_anchor_block: 20,
            ref_anchor_start: 0,
            tx_root: string
        }
    },
    contract_index: {
        [k: string]: number[]
    }

    txs: Array<TransactionConfirmed>
}

interface RollupHeader extends VSCSignedData {
    
    //DAG root of witness consensus list
    witness_root: CID
    merkle_hash: string
}

interface BlockHeaderIdea {
    
}



export interface TransactionConfirmed {
    op: string
    id: string // cid of transactionRaw
    type: TransactionDbType
}




export interface VSCSignedData {
    //This stays with the data at all times. It is not removed from the payload when verifying
    required_auths: Array<{
        type?: 'consensus' | 'active' | 'posting',
        value: string
    }>
    //Removed when verifying
    signatures?: SignaturePacked | CID //signature on IPFS.
}

export enum SignatureType {
    JWS = 'JWS',
    HIVE = 'HIVE',
    BLS = 'DID-BLS',
    BLS_AGG = 'DID-BLS-AGG'
}

export interface SignatureIndividual {
    //Separate between JWS, HIVE, and custom BLS signatures
    t: SignatureType; 
    //Aka Protected 
    // i.e {"alg": "EdDSA", "kid": "did:key:...#did:key:..."}
    p?: string;
    s: string; // Base64 signature
}


export interface SignaturePacked {

    // 'hive:beeab0de000000000000000000000000:hiveio'
    
    signatures: Array<SignatureIndividual> 
}

export interface HiveAccountAuthority {
    account: string
    valid_from: number
    valid_to: number | null
    ref_id: string

    keys: Array<{
        t: 'posting' |  'active' | 'owner' | 'node_id' | 'consensus'
        ct: 'DID' | 'DID-BLS' | 'DID-BLS-AGG'
        key: string
    }>
}

export enum OutputCode {
    OK = 0,
    FAILED_GENERAL = -1
}

export interface OutputResult {
    code: OutputCode | number
    msg?: any
    logs?: string[]
    value?: any
    err?: any
}

export interface OutputEvent {
    domain: 'hive' | 'vsc'
    type: 'call' | ''
}

export interface OutputEvent2 {
    domain: 'hive' | 'vsc'
    type: 'call' | ''
}

export interface TxOutputBase {
    
    contract_id: string
    inputs: Array<{
        id: string
    }>
    state_merkle: string
    tx_merkle: string
    
    //Indexed by TX order in inputs array
    results: Array<OutputResult>
    
    events: Array<OutputEvent>
}


export interface TxOutputV2Signed extends TxOutputBase, VSCSignedData {}
//Header
export interface TxOutputHeaderBase {

    data: CID
    state_merkle: string
    events: []
}

export interface TxOutputHeader extends TxOutputHeaderBase, VSCSignedData {}


export interface TransactionDbRecordV2 {
    status: TransactionDbStatus
    id: string
    // op: string
    required_auths: Array<{
        type?: 'payer' | 'active' | 'posting',
        value: string
    }>
    headers: {
        contract_id?: string
        lock_block?: number
        nonce?: number
        intents?: Array<string>
    }
    data: any | null
    local: boolean
    accessible: boolean
    first_seen: Date
    src: 'vsc' | 'hive'
    //ID of anchor record
    anchored_id?: string
    //Full block ID of Hive block including anchor record
    anchored_block?: string
    anchored_height?: number
    //Witness data
    sig_hash?: string
}


export enum TransactionIntent {
    // # Query Params
    // limit = number in Hive
    // token = hive or hbd
    'hive.allow_transfer' = 'hive.allow_transfer'
  }

export interface TransactionContainerV2 {
    __t: 'vsc-tx'
    __v: '0.2'
    headers: {
        payer?: string
        lock_block?: string
        required_auths: Array<string>
        //Tuple of transaction intent enum and arguments as querystring
        nonce: number
        intents?: null | Array<string> 
        type: TransactionDbType
    }
    tx: { 
        op: string
        payload: any // cid of ContractInput, ContractOutput or ContractUpdate and so on..
    }
}

export interface AddrRecord {
    id: string
    headers: any
    controllers?:Array<string>
    type: 'vs1' | 'vs2' | 'vs3' | 'vs4'
}


export interface BlockHeaderDbRecord {
    id: string
    block: string
    end_block: number
    merkle_root: string
    proposer: string
    sig_root: string
    signers: Array<string>
    slot_height: number
    start_block: number
    stats: {
        size: number
    }
    ts: Date
}

export interface WitnessDbRecord {
    account: string
    ipfs_peer_id: string
    last_signed: number
    net_id: string
    version_id: string
    signing_keys: {
        posting: string
        active: string
        owner: string
    }
}


export interface AccountNonceDbRecord {
    id: string
    nonce: number
    key_group?: string
}



interface LedgerIn {
    amount: number
    from: string
    owner: string
    unit: "HBD" | "HIVE"
    dest?: string
}
interface LedgerOut {
    amount: number
    owner: string
    to: string
    unit: "HBD" | "HIVE"
    dest?: string
}
export type LedgerType = LedgerIn | LedgerOut

export type HiveTransactionDbRecord = {
    transaction_id: string
    index: number
    operations: AnyOperation[]
}

export type AnyOperation = IndexedKeysToTuple<ListOfOperations>

type IndexedKeysToTuple<T extends {0: any; 1: any}> = T extends {0: infer A; 1: infer B} ? [A, B] : never

type ListOfOperations =
  | AccountCreateOperation
  | AccountCreateWithDelegationOperation
  | AccountUpdateOperation
  | AccountWitnessProxyOperation
  | AccountWitnessVoteOperation
  | CancelTransferFromSavingsOperation
  | ChangeRecoveryAccountOperation
  | ClaimRewardBalanceOperation
  | ClaimAccountOperation
  | CommentOperation
  | CommentOptionsOperation
  | ConvertOperation
  | CreateClaimedAccountOperation
  | CustomOperation
  | CustomBinaryOperation
  | CustomJsonOperation
  | DeclineVotingRightsOperation
  | DelegateVestingSharesOperation
  | DeleteCommentOperation
  | EscrowApproveOperation
  | EscrowDisputeOperation
  | EscrowReleaseOperation
  | EscrowTransferOperation
  | FeedPublishOperation
  | LimitOrderCancelOperation
  | LimitOrderCreateOperation
  | LimitOrderCreate2Operation
  | PowOperation
  | Pow2Operation
  | RecoverAccountOperation
  | ReportOverProductionOperation
  | RequestAccountRecoveryOperation
  | ResetAccountOperation
  | SetResetAccountOperation
  | SetWithdrawVestingRouteOperation
  | TransferOperation
  | TransferFromSavingsOperation
  | TransferToSavingsOperation
  | TransferToVestingOperation
  | VoteOperation
  | WithdrawVestingOperation
  | WitnessUpdateOperation
  | WitnessSetPropertiesOperation
  | AccountUpdate2Operation
  | CreateProposalOperation
  | UpdateProposalVotesOperation
  | RemoveProposalOperation
  | UpdateProposalOperation
  | CollateralizedConvertOperation
  | RecurrentTransferOperation;
