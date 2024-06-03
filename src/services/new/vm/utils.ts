import loader from '@assemblyscript/loader'
import Path, {dirname} from 'path'
import {fork, ChildProcess} from 'child_process'
import { fileURLToPath } from 'url';
import EventEmitter from 'events'
import Crypto from 'crypto'
import Pushable from 'it-pushable';
import { MONGODB_URL } from '../../db';
import { LedgerType } from '../types';
import type { AnyReceivedMessage, AnySentMessage, Env, ExecuteStopMessage, FinishResultMessage, PartialResultMessage } from './types';

export const CONTRACT_TIMEOUT_ERROR = new Error('contract execution timeout')

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


/**
 * Copyright 2019 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Put `__asyncify_data` somewhere at the start.
// This address is pretty hand-wavy and we might want to make it configurable in future.
// See https://github.com/WebAssembly/binaryen/blob/6371cf63687c3f638b599e086ca668c04a26cbbb/src/passes/Asyncify.cpp#L106-L113
// for structure details.
const DATA_ADDR = 16
// Place actual data right after the descriptor (which is 2 * sizeof(i32) = 8 bytes).
const DATA_START = DATA_ADDR + 8
// End data at 1024 bytes. This is where the unused area by Clang ends and real stack / data begins.
// Because this might differ between languages and parameters passed to wasm-ld, ideally we would
// use `__stack_pointer` here, but, sadly, it's not exposed via exports yet.
const DATA_END = 1024

const WRAPPED_EXPORTS = new WeakMap()

const State = {
  None: 0,
  Unwinding: 1,
  Rewinding: 2,
}

function isPromise(obj) {
  return (
    !!obj &&
    (typeof obj === 'object' || typeof obj === 'function') &&
    typeof obj.then === 'function'
  )
}

function proxyGet(obj, transform) {
  return new Proxy(obj, {
    get: (obj, name) => transform(obj[name]),
  })
}

class Asyncify {
  exports: any
  value: any
  constructor() {
    this.value = undefined
    this.exports = null
  }

  getState() {
    return this.exports.asyncify_get_state()
  }

  assertNoneState() {
    let state = this.getState()
    if (state !== State.None) {
      throw new Error(`Invalid async state ${state}, expected 0.`)
    }
  }

  wrapImportFn(fn) {
    return (...args) => {
      if (this.getState() === State.Rewinding) {
        this.exports.asyncify_stop_rewind()
        return this.value
      }
      this.assertNoneState()
      let value = fn(...args)
      if (!isPromise(value)) {
        return value
      }
      this.exports.asyncify_start_unwind(DATA_ADDR)
      this.value = value
    }
  }

  wrapModuleImports(module) {
    return proxyGet(module, (value) => {
      if (typeof value === 'function') {
        return this.wrapImportFn(value)
      }
      return value
    })
  }

  wrapImports(imports) {
    if (imports === undefined) return

    return proxyGet(imports, (moduleImports = Object.create(null)) =>
      this.wrapModuleImports(moduleImports),
    )
  }

  wrapExportFn(fn) {
    let newExport = WRAPPED_EXPORTS.get(fn)

    if (newExport !== undefined) {
      return newExport
    }

    newExport = async (...args) => {
      this.assertNoneState()

      let result = fn(...args)

      while (this.getState() === State.Unwinding) {
        this.exports.asyncify_stop_unwind()
        this.value = await this.value
        this.assertNoneState()
        this.exports.asyncify_start_rewind(DATA_ADDR)
        result = fn()
      }

      this.assertNoneState()

      return result
    }

    WRAPPED_EXPORTS.set(fn, newExport)

    return newExport
  }

  wrapExports(exports) {
    let newExports = Object.create(null)

    for (let exportName in exports) {
      let value = exports[exportName]
      if (typeof value === 'function' && !exportName.startsWith('asyncify_')) {
        value = this.wrapExportFn(value)
      }
      Object.defineProperty(newExports, exportName, {
        enumerable: true,
        value,
      })
    }

    WRAPPED_EXPORTS.set(exports, newExports)

    return newExports
  }

  init(instance, imports) {
    const { exports } = instance

    const memory = exports.memory || (imports.env && imports.env.memory)

    new Int32Array(memory.buffer, DATA_ADDR).set([DATA_START, DATA_END])

    this.exports = this.wrapExports(exports)

    Object.setPrototypeOf(instance, Instance.prototype)
  }
}

export class Instance extends WebAssembly.Instance {
  constructor(module, imports) {
    let state = new Asyncify()
    super(module, state.wrapImports(imports))
    state.init(this, imports)
  }

  get exports() {
    return WRAPPED_EXPORTS.get(super.exports)
  }
}

Object.defineProperty(Instance.prototype, 'exports', { enumerable: true })

export async function instantiate(source, imports) {
  let state = new Asyncify()
  let result = await loader.instantiate(source, state.wrapImports(imports))
  state.init(result instanceof WebAssembly.Instance ? result : result.instance, imports)
  return result
}

export async function instantiateStreaming(source, imports) {
  let state = new Asyncify()
  let result = await WebAssembly.instantiateStreaming(source, state.wrapImports(imports))
  state.init(result.instance, imports)
  return result
}

enum CallResultError {
  TIMEOUT = 'timeout'
}

export enum ContractErrorType {
  //If the contract does not exist
  INVALID_CONTRACT = 1,
  //If transaction attempts to call invalid runtime function.
  INVALID_ACTION = -1,
  //Input data does not meet valiation requirements
  INVALID_INPUT = -2,
  //Any arbitrary exception occurred within the smart contract 
  RUNTIME_EXCEPTION = -3,
  //Code error if WASM imports or attempts to use unavailable bindings.
  RUNTIME_SETUP = -4,
  //Unknown runtime error occurrs.
  RUNTIME_UNKNOWN = -5,
  //If overall VM becomes frozen a timeout is issued.
  TIMEOUT = -6,
  //If contract returns none JSON or other accepted format
  INVALID_RETURN = -7,


  //Reserved for future use.
  //If contract over uses gas or TX does not have enough gas.
  GAS_EXHAUSTED = -20
  
}

interface VmCallResult {
  code: number
  result: string
  logs: Array<string>
  err: null | CallResultError
}

export class VmContainer {
  proc: {
    start_time: Date
    timer_pid: number
  }
  child: ChildProcess
  opts: {
    // contract_id: string
    // state_merkle: string
    // cid: string
    state: {
      [x: string]: string
    }
    modules: {
      [x: string]: string
    }
    debug?: boolean
    timeout?: number
  }
  ready: boolean
  events: EventEmitter<{
    timeout: [{
      type: 'timeout'
    }],
    ready: [],
  } | {
    [msgType in Exclude<AnyReceivedMessage['type'], 'ready'>]: [AnyReceivedMessage & {type: msgType}]
  }>;
  reqId: string;

  constructor(opts: {
    // contract_id: string
    // state_merkle: string
    // cid: string
    state: {
      [x: string]: string
    }
    modules: {
      [x: string]: string
    }
    debug?: boolean
    timeout?: number
  }) {
    this.opts = opts
    this.events = new EventEmitter()
  }

  async call(args: {
    contract_id: string
    action: string
    payload: string
    intents?: Array<string>
    env: Env
  }) {
    let reqId = Crypto.randomBytes(8).toString('base64url')
    this.reqId = reqId
    const startTime = new Date();
    this.child.send({
      type: "call",
      action: args.action,
      payload: args.payload,
      intents: args.intents || [],
      env: args.env,
      contract_id: args.contract_id,
      reqId
    } satisfies AnySentMessage);
    const timeoutPid = setInterval(() => {
      const lag = new Date().getTime() - startTime.getTime();
      if(lag > 50) {
        this.events.emit('timeout', {
          type: 'timeout'
        })
      }
    }, this.opts.timeout || 2)
    const executeStop = await new Promise<ExecuteStopMessage | {type: 'timeout'}>((resolve, reject) => {
      this.events.once('execute-stop', (result0) => {
        resolve(result0)
        clearInterval(timeoutPid)
      })
      this.events.once('timeout', (resultErr) => {
        resolve(resultErr)
        clearInterval(timeoutPid)
      })
    })
    
    return executeStop
  }
  
  async finish() {
    if(this.child.connected) {
      this.child.send({
        type: 'finish'
      } satisfies AnySentMessage)
      const result = await new Promise<FinishResultMessage>((resolve, reject) => {
        this.events.once('finish-result', (result0) => {
          console.log('finish-result', this.child.connected)
          resolve(result0)
        })
        this.events.once('timeout', (resultErr) => {
          reject(CONTRACT_TIMEOUT_ERROR)
        })
      })
      return result;
    } else {
      return null;
    }
  }

  finishIterator() {
    const pushable = Pushable<PartialResultMessage>()
    if(this.child.connected) {
      this.child.send({
        type: 'finish'
      })

      void (async () => {
        const func = (result0: PartialResultMessage) => {
          pushable.push(result0)
        };
        this.events.on('partial-result', func)
        this.events.once('timeout', (resultErr) => {
          this.events.off('partial-result', func)
          pushable.end(CONTRACT_TIMEOUT_ERROR)
        })
        this.events.once('finish-result', () => {
          this.events.off('partial-result', func) // don't leak memory
          pushable.end()
        })

      })()
      return pushable
    } else {
      pushable.end()
      return pushable;
    }
  }

  async init() {

    const parameters = [];
    
    const partPath = Path.join(__dirname, 'vm-runner.js').replace('src', 'dist')

    const child = fork(partPath, parameters, {
        env: {
          // cid: this.opts.cid,
          // contract_id: this.opts.contract_id,
          state: JSON.stringify(this.opts.state),
          modules: JSON.stringify(this.opts.modules),
          IPFS_HOST: process.env.IPFS_HOST,
          MONGODB_URL,
        } as any,
        // silent: true,
        detached: false,
        silent: this.opts.debug ? !this.opts.debug : true
    });
    this.child = child;
    this.child.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null || !('type' in message)) {
        return;
      }
      if(message.type === 'ready') {
        this.ready = true
        this.events.emit('ready')
      }
      // TODO zod runtime type validation
      if(message.type === 'finish-result') {
        this.events.emit('finish-result', message as FinishResultMessage)
      }
      if(message.type === 'partial-result') {
        this.events.emit('partial-result', message as PartialResultMessage)
      }
      if(message.type === 'execute-stop') {
        this.events.emit('execute-stop', message as ExecuteStopMessage)
      }
    })
  }

  cleanup() {
    this.child.kill()
  }

  async onReady() {
    if (this.ready) {
      return
    }
    return new Promise<void>((resolve) => {
      this.events.on('ready', resolve)
    })
  }
}
