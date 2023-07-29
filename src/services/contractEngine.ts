import { Collection } from 'mongodb'
import { NodeVM, VM, VMScript } from 'vm2'
import { CID } from 'multiformats'
import jsonpatch from 'fast-json-patch'
import SHA256 from 'crypto-js/sha256'
import enchex from 'crypto-js/enc-hex'
import { CoreService } from './index'
import { verifyMultiDagJWS, Benchmark } from '../utils'
import { Contract, ContractCommitment } from '../types/contracts'
import { ContractOutput } from '../types/vscTransactions'
import { DID } from 'dids'

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
      // console.log(this)
      // this = new Date(0)
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
let codeTemplate = `
function wrapper () {
    RegExp.prototype.constructor = function () { };
    RegExp.prototype.exec = function () {  };
    RegExp.prototype.test = function () {  };
    Math.random = function () {  };

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

  /**
   * Executes a list of operations
   * @param id
   */
  async contractExecuteRaw(id, operations, options: {
    benchmark: Benchmark
  }): Promise<ContractOutput> {
    const benchmark = options.benchmark
    if(operations.length === 0) {
      throw new Error('A minimum of one contract operation should be specified')
    }
    const contractInfo = await this.contractDb.findOne({
      id,
    })
    if(!contractInfo) {
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
    
    let code = codeTemplate.replace('###ACTIONS###', codeRaw)
    
    const script = new VMScript(code).compile()

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
      
      const executeOutput = (await new Promise((resolve, reject) => {
        const vm = new NodeVM({
          sandbox: {
            Date: MockDate,
            utils: {
              SHA256: (payloadToHash) => {
                if (typeof payloadToHash === 'string') {
                  return SHA256(payloadToHash).toString(enchex);
                }
    
                return SHA256(JSON.stringify(payloadToHash)).toString(enchex);
              },
            },
            api: {
              action: opData.action,
              payload: opData.payload,
              input: {
                sender: {
                  type: "DID",
                  id: op.account_auth
                },
                tx_id: op.id,
                included_in: op.included_in
              },
              transferFunds: this.transferFunds,
              withdrawFunds: this.withdrawFunds
            },
            done: () => {
              return resolve(state.finish())
            },
            // console: "redirect",
            state: state.client,
          },
        })
        vm.run(script, 'vm.js')
      })) as { stateMerkle: string }
      stateMerkle = executeOutput.stateMerkle
    }

    this.self.logger.info('new state merkle of executed contract', stateMerkle)
    benchmark.stage('4')
    
    if(!(startMerkle instanceof CID)) {
      startMerkle = CID.parse(startMerkle);
    }
    
    if(!(stateMerkle instanceof CID)) {
      stateMerkle = CID.parse(stateMerkle);
    }

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
