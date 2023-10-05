import { Collection } from 'mongodb'
import ivm from 'isolated-vm'
import { CID } from 'multiformats'
import jsonpatch from 'fast-json-patch'
import SHA256 from 'crypto-js/sha256'
import enchex from 'crypto-js/enc-hex'
import { CoreService } from './index'
import { verifyMultiDagJWS, Benchmark } from '../utils'
import { Contract, ContractCommitment } from '../types/contracts'
import { ContractOutput } from '../types/vscTransactions'
import { DID } from 'dids'
import { CustomJsonOperation, TransferOperation } from '@hiveio/dhive'
import { BlockRef } from '@/types'
import { parseTxHex, reverse } from '../scripts/bitcoin-wrapper/utils'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'


export type HiveOps = CustomJsonOperation | TransferOperation

export class OutputActions {
  opStack: Array<any>

  constructor() {
    this.opStack = []
  }

  addHiveOp(input: HiveOps) {
    return this.opStack.push(input)
  }
}
let codeTemplate = `
function wrapper () {
  RegExp.prototype.constructor = function () { };
  RegExp.prototype.exec = function () {  };
  RegExp.prototype.test = function () {  };
  Math.random = function () {  };
  class MockDate extends Date {
    constructor(val) {
      if(val) {
        if(typeof val === 'string') {
          if(val.endsWith('Z')) {
            super(val)
          } else {
            super(val + "Z")
          }
        } else {
          super(val)
        }
      } else {
        super(0);
      }
    }

    getTimezoneOffset() {
      return 0;
    }

    toLocaleString() {
      return this.toUTCString()
    }

    static now() {
      return 0;
    }
  }
  class OutputActions {
    constructor() {
      this.opStack = []
    }

    addHiveOp(input) {
      return this.opStack.push(input)
    }
  }

  Date = MockDate;
  let utils = {
    SHA256: sha256,
    bitcoin: {
      ValidateSPV: {
        validateHeaderChain: btc_validate_spv_header_chain,
        validateProof: btc_validate_spv_proof
      }
      ser: {
        deserializeSPVProof: btc_ser_deserialize_spv_proof
      },
      parseTxHex: btc_parse_tx_hex,
      reverseBytes: btc_reverse_bytes,
      BTCUtils: {
        extractPrevBlockLE: btc_utils_extract_prev_block_le
        extractTimestamp: btc_utils_extract_ts
        extractTimestampLE: btc_utils_extract_ts_le
        extractMerkleRootLE: btc_utils_extract_merkleroot_le
        hash256: btc_utils_hash256
        extractOutputAtIndex: btc_utils_extract_output_at_idx
        extractValue: btc_utils_extract_value
      },
      SPVUtils: {
        deserializeHex: btc_spv_utils_deserialize_hex
      }
    }
  }
  let output = {
    setChainActions: set_chain_actions
  }
  api = api.copy();
  api.transferFunds = async (to, amount) => {
    return await (await transfer_funds.applySyncPromise(undefined, [to, amount])).copy()
  }
  api.withdrawFunds = async (amount) => {
    return await (await withdraw_funds.applySyncPromise(undefined, [amount])).copy()
  }
  let state = {
    remoteState: async (id) => {
      let result = await (await state_remote.applySyncPromise(undefined, [id])).copy()
      return {
        pull: async (key) => {
          return await (await result.pull.applySyncPromise(undefined, [key])).copy()
        },
        ls: async (key) => {
          return await (await result.ls.applySyncPromise(undefined, [key])).copy()
        }
      }
    },
    pull: async (key) => {
      return await (await state_pull.applySyncPromise(undefined, [key])).copy()
    },
    update: async (key, value) => {
      await state_update.applySyncPromise(undefined, [key, value])
    },
    ls: async (key) => {
      return await (await state_ls.applySyncPromise(undefined, [key])).copy()
    },
    del: async (key) => {
      await state_del.applySyncPromise(undefined, [key])
    }
  }

  let actions = {};

  ###ACTIONS###

  const execute = async function () {
    try {
      if (api.action && typeof api.action === 'string' && typeof actions[api.action] === 'function') {
        if (api.action !== 'init') {
          actions.init = null;
        }
        await actions[api.action](api.payload);
        if(api.payload) {
          done(api.payload)
        }
        done(null);
      } else {
        done('invalid action');
      }
    } catch (error) {
      done(error);
    }
  }

  execute();
}
wrapper();
`

export class ContractEngine {
  self: CoreService
  contractDb: Collection<Contract>
  contractCommitmentDb: Collection<ContractCommitment>
  contractLog: Collection<ContractOutput>
  contractCache: Record<string, string>

  constructor(self: CoreService) {
    this.self = self

    this.contractCache = {}
  }

  private async transferFunds(to: DID, amount: number) {
    // to be implemented
  }

  private async withdrawFunds(amount: number) {
    // to be implemented
    // uses transferFunds under the hood
  }

  private async contractStateExecutor(id: string) {
    let stateCid
    let contract = await this.contractDb.findOne({
      id,
    })
    if (contract) {
      if (contract.state_merkle) {
        stateCid = CID.parse(contract.state_merkle)
      } else {
        stateCid = await this.self.ipfs.object.new()
      }
    }

    return {
      pull: async (key: string) => {
        try {
          const obj = await this.self.ipfs.dag.resolve(stateCid, {
            path: `${key}`,
          })
          const out = await this.self.ipfs.dag.get(obj.cid)
          return out.value
        } catch (ex) {
          return null
        }
      },
      update: async (key, value: any) => {
        const outCid = await this.self.ipfs.dag.put(value)
        const merkleCid = await this.self.ipfs.object.patch.addLink(stateCid, {
          Name: key,
          Hash: outCid,
        })

        this.self.logger.verbose(`[Smart Contract Execution] Updated  Merkle Root to ${merkleCid}`)
        //TODO make this happen after contract call has been completely executed
        await this.contractDb.findOneAndUpdate(contract, {
          $set: {
            stateMerkle: merkleCid.toString(),
          },
        })
        //stateCid = obj;
      },
    }
    /*
            const txCid = await this.self.ipfs.dag.put(payload.payload)
            let protoBuf = await this.self.ipfs.object.patch.addLink(cid, {
                Name: payload.payload.peer_id,
                Hash: txCid
            })
            //console.log('protoBuf', protoBuf)
            state_updates['node-info'] = protoBuf;*/
  }

  private async contractStateRaw(id: string, stateMerkle?: string) {
    let stateCid
    let contract = await this.contractDb.findOne({
      id,
    })
    if(!contract) {
      throw new Error("Contract Not Indexed Or Does Not Exist")
    }
    if (contract) {
      if (stateMerkle) {
        stateCid = CID.parse(stateMerkle)
      } else {
        if (contract.state_merkle) {
          stateCid = CID.parse(contract.state_merkle)
        } else {
          stateCid = await this.self.ipfs.object.new()
        }
      }
    }

    return {
      client: {
        /**
         * 
         * @param id Contract ID
         */
        remoteState: async(id: string) => {
          const state = await this.contractStateRaw(id)

          return {
            pull: state.client.pull,
            ls: state.client.ls,
          }
        },
        pull: async (key: string) => {
          try {
            console.log(stateCid)
            const out = await this.self.ipfs.dag.resolve(stateCid, {
              path: key,
            })

            const data = await this.self.ipfs.dag.get(out.cid)

            console.log(data)
            if (out.cid.code === 0x70) {
              //PD Dag
              return JSON.parse(Buffer.from(data.value.Data).toString())
            } else if (out.cid.code === 0x71) {
              //CBOR dag
              return data.value
            } else {
              //This shouldn't happen unless other issues are present.
              return null
            }
          } catch (ex) {
            console.log(ex)
            return null
          }
        },
        update: async (key, value: any) => {
          try {

            if (!value) {
              return
            }
            let merkleCid = stateCid
  
            let linkExists
            let dagData
            let brokenPaths = []
            try {
              const resolvedCid = await this.self.ipfs.dag.resolve(merkleCid, {
                path: key,
              })
  
              const rawData = await this.self.ipfs.dag.get(resolvedCid.cid)
              if (resolvedCid.cid.code === 0x70) {
                dagData = JSON.parse(Buffer.from(rawData.value.Data).toString())
              } else if (resolvedCid.cid.code === 0x71) {
                dagData = rawData.value
              }
            } catch (ex) {
              linkExists = false
              let splitKey = key.split('/')
              for (let x = 0; x < splitKey.length; x++) {
                let partialKey = splitKey.slice(0, splitKey.length - 1 - x)
                console.log(partialKey)
  
                try {
                  const cid = await this.self.ipfs.dag.resolve(merkleCid, {
                    path: partialKey.join('/'),
                  })
                  console.log(cid.cid.code)
                  if (cid.cid.code === 0x70) {
                    break
                  } else {
                    brokenPaths.push({
                      path: partialKey.join('/'),
                      cid: cid.cid,
                      wrongFormat: true,
                    })
                  }
                } catch {
                  brokenPaths.push({ path: partialKey.join('/') })
                }
              }
            }
  
            for (let brokenPath of brokenPaths.reverse()) {
              if (brokenPath.wrongFormat) {
                const data = await this.self.ipfs.dag.get(brokenPath.cid)
                const linkCid = await this.self.ipfs.object.put({
                  Data: Buffer.from(JSON.stringify(data.value)),
                  Links: [],
                })
                merkleCid = await this.self.ipfs.object.patch.addLink(merkleCid, {
                  Name: brokenPath.path,
                  Hash: linkCid,
                })
              } else {
                merkleCid = await this.self.ipfs.object.patch.addLink(merkleCid, {
                  Name: brokenPath.path,
                  Hash: CID.parse('QmdfTbBqBPQ7VNxZEYEj14VmRuZBkqFbiwReogJgS1zR1n'),
                })
              }
            }
  
            const dataCid = await this.self.ipfs.dag.put(value)
  
            merkleCid = await this.self.ipfs.object.patch.addLink(merkleCid, {
              Name: key,
              Hash: dataCid,
            })
  
            stateCid = merkleCid
          } catch (ex) {
            console.log(ex)
          }
          //TODO make this happen after contract call has been completely executed
          //stateCid = obj;
        },
        /**
         * WIP: needs DAG type updates
         * @param key 
         * @returns 
         */
        ls: async (key) => {
          try {
            const pBufNode = await this.self.ipfs.object.get(`${stateCid}/${key}` as any)
            console.log(pBufNode.Links)
            return pBufNode.Links.map((e) => e.Name)
          } catch {
            return []
          }
        },
        del: async (key) => {
          //To be implemented!
        },
      },
      finish: () => {
        return {
          stateMerkle: stateCid,
        }
      },
      startMerkle: stateCid,
    }
  }

  /*
  async executeContract(id, call, args) {
    const contractInfo = await this.contractDb.findOne({
      id,
    })

    if(!contractInfo) {
      throw new Error("Contract Not Indexed Or Does Not Exist")
    }
    let codeRaw = ''
    for await (const chunk of this.self.ipfs.cat(contractInfo.code)) {
      codeRaw = codeRaw + chunk.toString()
    }

    let code = codeTemplate.replace('###ACTIONS###', codeRaw)

    const script = new VMScript(code).compile()
    const vm = new NodeVM({
      sandbox: {
        api: {
          action: 'init',
          payload: 'hello',
        },
        done: (msg) => {
          //this.self.logger.info('executed contract', msg)
        },
        state: await this.contractStateExecutor(id),
      },
    })
    await vm.run(script, 'vm.js')
  }
  */

  /**
   * Executes a list of operations
   * @param id
   */
  async contractExecuteRaw(id, operations, options: {
    benchmark: Benchmark
    codeOverride?: string
  }): Promise<ContractOutput> {
    const benchmark = options.benchmark
    if(operations.length === 0) {
      throw new Error('A minimum of one contract operation should be specified')
    }
    const contractInfo = await this.contractDb.findOne({
      id,
    })
    if(!contractInfo) {
      await this.contractDb.findOneAndUpdate({
        id
      }, {
        $set: {
          status: 'FAILED'
        }
      })
      throw new Error('Smart contract not registered with node')
    }
    let codeRaw = ''
    if(!this.contractCache[id]) {
      for await (const chunk of this.self.ipfs.cat(contractInfo.code)) {
        codeRaw = codeRaw + chunk.toString()
      }
      this.contractCache[id] = codeRaw
    } else {
      codeRaw = this.contractCache[id]
    }

    let code = codeTemplate.replace('###ACTIONS###', options.codeOverride || codeRaw)

    let chainActions = null
    let stateMerkle
    let startMerkle
    for (let op of operations) {
      const opData = (await this.self.ipfs.dag.get(CID.parse(op.id), {
        path: "/link/tx"
      })).value
      this.self.logger.debug(`executing op: ${op}`, opData)
      //Performance: access should be instant
      if(!contractInfo) {
        throw new Error("Contract Not Indexed Or Does Not Exist")
      }
      //Performance: access should be loaded from disk unless content is remote
      
      const state = await this.contractStateRaw(id, stateMerkle)
      if (!startMerkle) {
        startMerkle = state.startMerkle.toString()
      }

      const includedRecord = await this.self.chainBridge.blockHeaders.findOne({
        id: op.included_in
      })

      const isolate = new ivm.Isolate({ memoryLimit: 128 }) // fixed 128MB memory limit for now, maybe should be part of tx fee calculation
      const context = await isolate.createContext()
      context.global.setSync('global', context.global.derefInto())
      context.global.setSync('sha256', (payloadToHash: string | object) => {
        if (typeof payloadToHash === 'string') {
          return SHA256(payloadToHash).toString(enchex);
        }

        return SHA256(JSON.stringify(payloadToHash)).toString(enchex);
      })

      // btc functions
      context.global.setSync('btc_validate_spv_header_chain', ValidateSPV.validateHeaderChain)
      context.global.setSync('btc_validate_spv_proof', ValidateSPV.validateProof)
      context.global.setSync('btc_ser_deserialize_spv_proof', ser.deserializeSPVProof)
      context.global.setSync('btc_parse_tx_hex', parseTxHex)
      context.global.setSync('btc_reverse_bytes', reverse)
      context.global.setSync('btc_utils_extract_prev_block_le', BTCUtils.extractPrevBlockLE)
      context.global.setSync('btc_utils_extract_ts', BTCUtils.extractTimestamp)
      context.global.setSync('btc_utils_extract_ts_le', BTCUtils.extractTimestampLE)
      context.global.setSync('btc_utils_extract_merkleroot_le', BTCUtils.extractMerkleRootLE)
      context.global.setSync('btc_utils_hash256', BTCUtils.hash256)
      context.global.setSync('btc_utils_extract_output_at_idx', BTCUtils.extractOutputAtIndex)
      context.global.setSync('btc_utils_extract_value', BTCUtils.extractValue)
      context.global.setSync('btc_spv_utils_deserialize_hex', utils.deserializeHex)

      // apis
      context.global.setSync('set_chain_actions', (actions: OutputActions) => {
        chainActions = (actions.opStack as Array<HiveOps>).map(e => ({tx: e}))
      })
      context.global.setSync('api', new ivm.ExternalCopy({
        action: opData.action,
        payload: opData.payload,
        input: {
          sender: {
            type: "DID",
            id: op.account_auth
          },
          tx_id: op.id,
          included_in: op.included_in,
          included_block: includedRecord.hive_ref_block,
          included_date: includedRecord.hive_ref_date
        }
      }))
      context.global.setSync('transfer_funds', new ivm.Reference(async (to: DID, amount: number) => {
        let result = await this.transferFunds(to, amount)
        return new ivm.ExternalCopy(result)
      }))
      context.global.setSync('withdraw_funds', new ivm.Reference(async (amount: number) => {
        let result = await this.withdrawFunds(amount)
        return new ivm.ExternalCopy(result)
      }))
      context.global.setSync('get_balance', new ivm.Reference(async (accountId: string) => {
        let result = await this.self.chainBridge.calculateBalanceSum(accountId, {
          // pla: TODO, NEED TO SUPPLY CURRENT BLOCK INFORMATION IN ORDER TO CALC THE BALANCE
        } as BlockRef, id)
        return new ivm.ExternalCopy(result)
      }))

      // state
      context.global.setSync('state_remote', new ivm.Reference(async (id: string) => {
        let result = await state.client.remoteState(id)
        return new ivm.ExternalCopy({
          pull: new ivm.Reference(async (key: string) => new ivm.ExternalCopy(await result.pull(key))),
          ls: new ivm.Reference(async (key: string) => new ivm.ExternalCopy(await result.ls(key))),
        })
      }))
      context.global.setSync('state_pull', new ivm.Reference(async (key: string) => {
        let result = await state.client.pull(key)
        return new ivm.ExternalCopy(result)
      }))
      context.global.setSync('state_update', new ivm.Reference(async (key: string, value: any) => {
        await state.client.update(key, value)
      }))
      context.global.setSync('state_ls', new ivm.Reference(async (key: string) => {
        let result = await state.client.ls(key)
        return new ivm.ExternalCopy(result)
      }))
      context.global.setSync('state_del', new ivm.Reference(async (key: string) => {
        await state.client.del(key)
      }))
      context.global.setSync('done', () => {
        stateMerkle = state.finish().stateMerkle
      })
      const compiled = await isolate.compileScript(code)
      await compiled.run(context)
    }

    this.self.logger.info('new state merkle of executed contract', stateMerkle)
    benchmark.stage('4')
    
    if(!(startMerkle instanceof CID)) {
      startMerkle = CID.parse(startMerkle);
    }
    
    stateMerkle = CID.asCID(stateMerkle);

    let startMerkleObj = await this.self.ipfs.dag.get(startMerkle)
    startMerkleObj.value.Links = startMerkleObj.value.Links.map((e) => {
      return {
        ...e,
        Hash: e.Hash.toString(),
      }
    })
    let stateMerkleObj = await this.self.ipfs.dag.get(stateMerkle)
    stateMerkleObj.value.Links = stateMerkleObj.value.Links.map((e) => {
      return { 
        ...e,
        Hash: e.Hash.toString(),
      }
    })

    

    this.self.logger.debug('state merkle object of executed contract', startMerkleObj)
    benchmark.stage('4.5')
    const merkleDiff = jsonpatch.compare(startMerkleObj, stateMerkleObj)

    benchmark.stage('5')
    

    let log_matrix = {}
    for (let logOp of merkleDiff) {
      if (['add', 'replace'].includes(logOp.op)) {
        let initObj = {}
        let endObj = {}
        if (logOp.op === 'replace') {
          if(typeof logOp.value !== 'object') {
            continue;
          }
          const obj = await this.self.ipfs.dag.resolve(startMerkle, {
            path: `${logOp.value.Name}`,
          })
          initObj = (await this.self.ipfs.dag.get(obj.cid)).value
        }
        //If statement for typescript reasons
        if (logOp.op === 'add' || logOp.op === 'replace') {
          try {
            if(typeof logOp.value !== 'object') {
              continue;
            }
            const obj = await this.self.ipfs.dag.resolve(stateMerkle, {
              path: `${logOp.value.Name}`,
            })
            endObj = (await this.self.ipfs.dag.get(obj.cid)).value
          } catch (ex) {
            return null
          }
          // console.log({ initObj, endObj })
          log_matrix[logOp.value.Name] = jsonpatch.compare(initObj, endObj)
        }
      }
    }

    benchmark.stage('6')

    // console.log(await this.self.ipfs.dag.put(log_matrix))
    // console.log(
    //   JSON.stringify(
    //     {
    //       log_matrix,
    //     },
    //     null,
    //     2,
    //   ),
    // )

    return {
      contract_id: id,
      inputs: operations.map(e => {
        return {
          id: e.id
        }
      }),
      state_merkle: stateMerkle.toString(),
      log_matrix,
      chain_actions: chainActions
    } as ContractOutput
  }

  async createSmartContract() {
    const executorId = this.self.identity.id
  }

  async start() {
    this.contractDb = this.self.db.collection('contracts')
    this.contractCommitmentDb = this.self.db.collection('contract_commitment')
    this.contractLog = this.self.db.collection('contract_log')

    try {
      this.contractDb.createIndex(
        {
          id: -1,
        },
        {
          unique: true,
        },
      )
    } catch {}

    try {
      this.contractCommitmentDb.createIndex(
        {
          id: -1,
        },
        {
          unique: true,
        },
      )
    } catch {}

    try {
      this.contractLog.createIndex(
        {
          id: -1,
        },
        {
          unique: true,
        },
      )
    } catch {}

    try {
      this.contractLog.createIndex(
        {
          contract_id: -1,
        },
        {
          unique: true,
        },
      )
    } catch {}

    //await this.executeContract('kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz', 'init', {})

    // const output = await this.contractExecuteRaw(
    //   'kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz',
    //   [
    //     {
    //       id: 'bafyreietntvizm42d25qd2ppnng6mf7jkxyxpsgnsicomnqxxfowdcfsr4',
    //       action: 'set',
    //       payload: {
    //         key: 'hello',
    //         value: Math.random(),
    //       },
    //     },
    //     {
    //       id: "bafyreid2fn42ptf3v464nxmm6z24llvk23gsncggpzw34fuz5q6esgmldy",
    //       action: 'set',
    //       payload: {
    //         key: 'test-2',
    //         value: Math.random(),
    //       },
    //     },
    //     {
    //       id: 'bafyreicmyzlywkgizjsigz6j7evzpurflnqmbdmnr2ayj4nm7ewl3ipr2e',
    //       action: 'set',
    //       payload: {
    //         key: 'test',
    //         value: Math.random(),
    //       },
    //     },
    //   ],
    // )
    
    // const dag = await this.self.identity.createDagJWS(output)
    // let signers = [this.self.identity, this.self.wallet]
    
    // let signatures = []
    // let signedDag
    // for(let signer of signers) {
    //   signedDag = await signer.createDagJWS(output)
    //   // console.log('signedDag', signedDag) 
    //   signatures.push(...signedDag.jws.signatures)
    // }

    // let completeDag = {
    //   jws: {
    //     payload: signedDag.jws.payload,
    //     signatures,
    //     link: signedDag.jws.link
    //   },
    //   linkedBlock: await this.self.ipfs.block.put(signedDag.linkedBlock, {
    //     format: 'dag-cbor'
    //   })
    // }
    // // console.log(signatures)
    
    // try {
    //   const payload = await verifyMultiJWS(completeDag.jws, this.self.identity)
    //   // console.log(payload)
    // } catch(ex) {
    //   console.log(ex)
    // }
    
    // const completeDagCid = await this.self.ipfs.dag.put(completeDag)

    // //console.log(dag, completeDagCid)
    // //console.log(dag)
    // const test = await this.self.ipfs.dag.put(output)
    // //console.log(test)
    // //console.log(Buffer.from(dag.linkedBlock).toString())
    // const linkedBlock = await this.self.ipfs.block.put(dag.linkedBlock, {
    //   format: 'dag-cbor'
    // })
    // //console.log(linkedBlock)
    // const test2 = await this.self.ipfs.dag.put({
    //   jws: dag.jws,
    //   linkedBlock
    // })
    //console.log(test2)

  }
}
