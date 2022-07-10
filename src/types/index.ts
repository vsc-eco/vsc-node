import { TransactionDbType } from "../services/transactionPool"


//Engrained into the blockchain for reference
export interface BlockRecord {
    __t: 'vsc-block'
    state_updates: Record<string, string>
    //txs
    txs: string[]

    input_txs: Array<{
        type: string
        id: string
    }>
    previous?: any
}

export interface TransactionContainer {
    id?: string //Created during signing
    __t: 'vsc-tx'
    __v: '0.1'
    lock_block: string
    
    op: string
    payload: string
    type: TransactionDbType
}