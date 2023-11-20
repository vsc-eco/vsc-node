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
}

export interface BlockHeader extends VSCSignedData {
    // anchor_chains: {
    //     'hive:mainet': {
    //         //ref_anchor_pos: 79976520
    //         ref_anchor_block: number
    //         ref_anchor_start: number
    //     }
    // }

    // block: CID
    previous: CID

    block: CID
}

interface BlockContent {
    anchor_chains: {
        "hive:mainet": {
            ref_anchor_block: 20,
            ref_anchor_start: 0
        }
    },
    contract_index: {
        [k: string]: number[]
    }

    txs: Array<TransactionConfirmed>
    
}

interface RollupHeader extends VSCSignedData {
    
    consensus_dag: CID
    merkle_hash: string
}



export interface TransactionConfirmed {
    op: string
    id: string // cid of transactionRaw
    type: TransactionDbType
}




interface VSCSignedData {
    //This stays with the data at all times. It is not removed from the payload when verifying
    required_auths: Array<{
        type: 'consensus' | 'active' | 'posting',
        value: string
    }>
    //Removed when verifying
    signatures?: SignaturePacked | CID //signature on IPFS.
}

export enum SignatureType {
    JWS,
    HIVE,
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