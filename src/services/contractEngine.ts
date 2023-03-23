import { Collection } from 'mongodb'
import { NodeVM, VM, VMScript } from 'vm2'
import { CID } from 'multiformats'
import { CoreService } from './index'
import jsonpatch from 'fast-json-patch'
import { verifyMultiJWS, Benchmark } from '../utils'
import { logger } from '../common/logger.singleton'
import { Contract, ContractCommitment } from '../types/contracts'
import { ContractOutput } from '../types/vscTransactions'

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

  private async contractStateExecutor(id: string) {
    let stateCid
    let contract = await this.contractDb.findOne({
      id,
    })
    // console.log(contract)
    if (contract) {
      if (contract.state_merkle) {
        stateCid = CID.parse(contract.state_merkle)
      } else {
        stateCid = await this.self.ipfs.object.new()
      }
    }

    return {
      pull: async (key: string) => {
        // console.log(stateCid)
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

        logger.verbose(`[Smart Contract Execution] Updated  Merkle Root to ${merkleCid}`)
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
        stateCid = stateMerkle
      } else {
        if (contract.state_merkle) {
          stateCid = CID.parse(contract.state_merkle)
          stateCid = await this.self.ipfs.object.new()
        } else {
          stateCid = await this.self.ipfs.object.new()
        }
      }
    }

    return {
      client: {
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
          if (!value) {
            return
          }
          const outCid = await this.self.ipfs.dag.put(value, {
            pin: false
          })
          const merkleCid = await this.self.ipfs.object.patch.addLink(stateCid, {
            Name: key,
            Hash: outCid,
          })

          stateCid = merkleCid.toString()
          //TODO make this happen after contract call has been completely executed
          //stateCid = obj;
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
    //console.log(contractInfo, await this.self.ipfs.cat(contractInfo.code))
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
          // console.log(msg)
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
      console.log(op, opData)
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
            api: {
              action: opData.action,
              payload: opData.payload,
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

    console.log('269 stateMerkle', stateMerkle)
    benchmark.stage('4')
    
    if(!(startMerkle instanceof CID)) {
      startMerkle = CID.parse(startMerkle);
    }
    
    if(!(stateMerkle instanceof CID)) {
      stateMerkle = CID.parse(stateMerkle);
    }
    console.log('270 stateMerkle', stateMerkle)
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
    console.log('275 stateMerkle', stateMerkle)
    
    console.log(startMerkleObj, stateMerkleObj)
    benchmark.stage('4.5')
    const merkleDiff = jsonpatch.compare(startMerkleObj, stateMerkleObj)

    benchmark.stage('5')


    let log_matrix = {}
    for (let logOp of merkleDiff) {
      if (['add', 'replace'].includes(logOp.op)) {
        let initObj = {}
        let endObj = {}
        if (logOp.op === 'replace') {
          const obj = await this.self.ipfs.dag.resolve(startMerkle, {
            path: `${logOp.value.Name}`,
          })
          initObj = (await this.self.ipfs.dag.get(obj.cid)).value
        }
        //If statement for typescript reasons
        if (logOp.op === 'add' || logOp.op === 'replace') {
          try {
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
