import { Collection } from 'mongodb'
import { NodeVM, VM, VMScript } from 'vm2'
import { CID } from 'multiformats'
import { CoreService } from './index.js'
import * as jsonpatch from 'fast-json-patch'

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

interface Contract {
  id: string
  name: string
  code: string
  stateMerkle?: string //V0 of contract state
  creation_tx?: string
  created_at?: Date
}

interface JsonPatchOp {
  op: string
  path: string
  value: string | object | number
}

interface ContractOutput {
  id: string //Calculated when created/signed
  included_in: string //Generated when being included into an Anchor Block
  inputs: Array<{
    id: string
  }>
  stateMerkle: string
  //log: JsonPatchOp[]
  //Matrix of subdocuments --> individual logs
  log_matrix: Record<
    string,
    {
      log: JsonPatchOp[]
    }
  >
}

export class ContractEngine {
  self: CoreService
  contractDb: Collection<Contract>
  constructor(self: CoreService) {
    this.self = self
  }

  private async contractStateExecutor(id: string) {
    let stateCid
    let contract = await this.contractDb.findOne({
      id,
    })
    console.log(contract)
    if (contract) {
      if (contract.stateMerkle) {
        stateCid = CID.parse(contract.stateMerkle)
      } else {
        stateCid = await this.self.ipfs.object.new()
      }
    }

    return {
      pull: async (key: string) => {
        console.log(stateCid)
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

        console.log(merkleCid)
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
    console.log(contract)
    if (contract) {
      if (stateMerkle) {
        stateCid = stateMerkle
      } else {
        if (contract.stateMerkle) {
          stateCid = CID.parse(contract.stateMerkle)
        } else {
          stateCid = await this.self.ipfs.object.new()
        }
      }
    }

    return {
      client: {
        pull: async (key: string) => {
          console.log(stateCid)
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
          console.log(value)
          const outCid = await this.self.ipfs.dag.put(value)
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
          console.log(msg)
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
  async contractExecuteRaw(id, operations): Promise<{}> {
    let stateMerkle
    let startMerkle;
    for (let op of operations) {
      const contractInfo = await this.contractDb.findOne({
        id,
      })
      let codeRaw = ''
      for await (const chunk of this.self.ipfs.cat(contractInfo.code)) {
        codeRaw = codeRaw + chunk.toString()
      }

      let code = codeTemplate.replace('###ACTIONS###', codeRaw)

      const state = await this.contractStateRaw(id, stateMerkle)
      const script = new VMScript(code).compile()
      if(!startMerkle) {
        startMerkle = state.startMerkle.toString()
      }
      const executeOutput = (await new Promise((resolve, reject) => {
        const vm = new NodeVM({
          sandbox: {
            api: {
              action: op.action,
              payload: op.payload,
            },
            done: (msg) => {
              console.log('message is', msg, state.finish())
              return resolve(state.finish())
            },
            state: state.client,
          },
        })
        vm.run(script, 'vm.js')
      })) as { stateMerkle: string }
      console.log(executeOutput)
      stateMerkle = executeOutput.stateMerkle
    }
    let startMerkleObj = await this.self.ipfs.dag.get(CID.parse(startMerkle))
    startMerkleObj.value.Links = startMerkleObj.value.Links.map(e => {
        return {
            ...e,
            Hash: e.Hash.toString()
        }
    })
    let stateMerkleObj = await this.self.ipfs.dag.get(CID.parse(stateMerkle))
    stateMerkleObj.value.Links = stateMerkleObj.value.Links.map(e => {
        return {
            ...e,
            Hash: e.Hash.toString()
        }
    })
    console.log(JSON.stringify({stateMerkleObj, startMerkleObj}))
    const merkleDiff = jsonpatch.compare(startMerkleObj, stateMerkleObj)

    let log_matrix = {}
    for(let logOp of merkleDiff) {
        if(['add', 'replace'].includes(logOp.op)) {
            console.log(logOp)
            let initObj = {}
            let endObj = {}
            if(logOp.op === "replace") {
                const obj = await this.self.ipfs.dag.resolve(startMerkle, {
                    path: `${logOp.value.Name}`,
                  })
                initObj = (await this.self.ipfs.dag.get(obj.cid)).value
            }
            //If statement for typescript reasons
            if(logOp.op === "add" || logOp.op === "replace") {
                try {
                    const obj = await this.self.ipfs.dag.resolve(stateMerkle, {
                      path: `${logOp.value.Name}`,
                    })
                    endObj = (await this.self.ipfs.dag.get(obj.cid)).value
                    
                } catch (ex) {
                    return null
                }
                console.log({initObj, endObj})
                log_matrix[logOp.value.Name] = jsonpatch.compare(initObj, endObj)
            }
        }
    }
    
    console.log(await this.self.ipfs.dag.put(log_matrix))
    console.log(JSON.stringify({
        log_matrix
    }, null, 2))

    return {}
  }


  async createSmartContract() {
    const executorId = this.self.identity.id;
    console.log(executorId)
  }


  async start() {
    this.contractDb = this.self.db.collection('contracts')
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
    //await this.executeContract('kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz', 'init', {})
    await this.contractExecuteRaw(
      'kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz',
      [
        {
          action: 'set',
          payload: {
            key: 'hello',
            value: Math.random(),
          },
        },
        {
          action: 'set',
          payload: {
            key: 'test-2',
            value: Math.random(),
          },
        },
        {
          action: 'set',
          payload: {
            key: 'test',
            value: Math.random(),
          },
        },
      ],
    )
  }
}
