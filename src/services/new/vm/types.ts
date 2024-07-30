import { LedgerType } from "../types";
import { ContractErrorType } from "./utils";

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
    ledgerResults: LedgerType[],
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
}

export type CallMessage = Message & {
    type: 'call'
    contract_id: string,
    payload: string,
    action: string,
    intents: string[],
    env: Env,
    reqId: string,
}

export type FinishMessage = Message & {
    type: 'finish'
}

export type AnySentMessage = CallMessage | FinishMessage

export type AnyReceivedMessage = PartialResultMessage | FinishResultMessage | ReadyMessage | ExecuteStopMessage