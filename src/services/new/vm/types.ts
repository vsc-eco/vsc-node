import { ContractErrorType } from "./utils.js";

type Message = {type: string};

export type Env = {
  'anchor.id': string
  'anchor.block': string
  'anchor.timestamp': number
  'anchor.height': number
  'msg.sender': string
  'msg.required_auths': string[]
  'tx.origin': string
}

export type PartialResultMessage = Message & {
    type: 'partial-result',
    contract_id: string,
    index: string, // TODO change to number
    stateMerkle: string,
};

export type FinishResultMessage = Message & {
    type: 'finish-result'
}

export type ReadyMessage = Message & {
    type: 'ready'
}

export type ExecuteStopMessage = Message & {
    type: 'execute-stop',
    ret: string | null,
    errorType: ContractErrorType | null,
    error: string | null | {
        msg: string,
        file: string,
        line: number,
        colm: number,
    }
    logs:( string | number | boolean)[],
    IOGas: number,
    reqId: string,
    ledger: EventOp[],
}

export type CallMessage = Message & {
    type: 'call'
    contract_id: string,
    payload: string,
    action: string,
    intents: string[],
    balance_map: Record<string, {
        HBD: number
        HIVE: number
    }>
    env: Env,
    reqId: string,
}

export type FinishMessage = Message & {
    type: 'finish'
}

export type AnySentMessage = CallMessage | FinishMessage

export type AnyReceivedMessage = PartialResultMessage | FinishResultMessage | ReadyMessage | ExecuteStopMessage


export enum EventOpType {
    'ledger:transfer' = 110_001,
    'ledger:withdraw' = 110_002,
    'ledger:deposit' = 110_003,
  
    //Reserved for future, DO NOT USE
    'ledger:stake_hbd' = 110_004,
    'ledger:unstake_hbd' = 110_005,
    'ledger:claim_hbd' = 110_006,
    
    //Reserved for future, DO NOT USE
    'consensus:stake' = 100_001,
    'consensus:unstake' = 100_002
    
  }
  
  
  export interface EventOp {
    owner: string
    tk: 'HBD' | 'HIVE'
    t: EventOpType
    amt: number
    memo?: string
    
  }