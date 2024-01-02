import {CustomJsonOperation, TransferOperation} from '@hiveio/dhive/lib/chain/operation'
import type {ValidateSPV} from '@summa-tx/bitcoin-spv-js'

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      HIVE_ACCOUNT: string
      HIVE_ACCOUNT_POSTING: string
      HIVE_ACCOUNT_ACTIVE: string
      MULTISIG_ACCOUNT: string
      MULTISIG_ANTI_HACK: string
      MULTISIG_ANTI_HACK_KEY: string
    }
    interface Global {
      state: {
        pull(key: string): Promise<any>
        update(key: string, value: any): Promise<void>
      }
    }
    type workplease = "test"
    
  }
}

interface StateInterfaceRemote {
  pull<T>(key: string): Promise<T>
  ls(key: string): Promise<Array<string>>
}
interface StateInterface {
  remoteState(id: string): Promise<StateInterfaceRemote> 
  pull<T>(key: string): Promise<T>
  update<T>(key: string, value: T): Promise<void>
  ls(key: string): Promise<Array<string>>
}
interface APInterface {
  input: {
    sender: {
      type: "DID",
      id: string
    },
    tx_id: string,
    included_in: string
    included_block: number
    included_date: Date
  }
}

type Actions = Record<string, Function>

interface OuputInterface {
  setChainActions: (outputActions: OutputActions) => void
}

interface UtilsInterface {
  SHA256: (input: string) => string
  base58: {
    encode: (buf: Uint8Array) => string
    decode: (buf: string) => Uint8Array
    decodeUnsafe: (buf: string) => Uint8Array
  }
  
  bitcoin: {
    ValidateSPV
    BTCUtils
    SPVUtils
    reverseBytes
    ser
  }
}




if(test[0] === 'transfer') {
  console.log(test[1].memo)
}
interface VSCCustomJsonOperation {
  0: 'custom_json',
  1: {
    /**
         * ID string, must be less than 32 characters long.
         */
    id: string;
    /**
     * JSON encoded string, must be valid JSON.
     */
    json: string;
  }
}
type HiveOps = VSCCustomJsonOperation | TransferOperation
declare global {
  
  class OutputActions {
    opStack: Array<any>
  
    constructor() {
      this.opStack = []
    }
  
    addHiveOp(input: HiveOps) {
      return this.opStack.push(input)
    }
  }
  var state: StateInterface 
  var actions: Actions
  var output: OuputInterface
  var api: APInterface
  var utils: UtilsInterface
  function log(...input: any)
}

export {}
