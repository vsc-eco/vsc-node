import * as IPFS from 'kubo-rpc-client'
import { Collection, MongoClient } from 'mongodb'
import { addLink } from '../../../ipfs-utils/add-link'
import { removeLink } from '../../../ipfs-utils/rm-link'
import { ContractErrorType, instantiate } from './utils'

//Crypto imports
import { ripemd160, sha256 } from 'bitcoinjs-lib/src/crypto'
import { LedgerType } from '../types'

const CID = IPFS.CID

const ipfs = IPFS.create({ url: process.env.IPFS_HOST || 'http://127.0.0.1:5001' })

export class WasmRunner {
  stateCache: Map<string, any>
  constructor() {
    this.stateCache = new Map()
  }

  async contractStateRaw(id: string, stateMerkle?: string) {
    let stateCid
    // let contract = await this.contractDb.findOne({
    //   id,
    // })
    const contract = {} as any
    if (!contract) {
      throw new Error('Contract Not Indexed Or Does Not Exist')
    }
    if (contract) {
      if (stateMerkle) {
        stateCid = CID.parse(stateMerkle)
      } else {
        if (contract.state_merkle) {
          stateCid = CID.parse(contract.state_merkle)
        } else {
          stateCid = CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn')
        }
      }
    }

    return {
      client: {
        /**
         *
         * @param id Contract ID
         */
        remoteState: async (id: string) => {
          const state = await this.contractStateRaw(id)

          return {
            pull: state.client.pull,
            ls: state.client.ls,
          }
        },
        pull: async (key: string) => {
          try {
            console.log(stateCid)
            const out = await ipfs.dag.resolve(stateCid, {
              path: key,
            })

            const data = await ipfs.dag.get(out.cid)

            console.log(data)
            if (out.cid.code === 0x70) {
              //If accidentally requesting PD-dag
              const out = await ipfs.dag.resolve(stateCid, {
                path: `${key}/.self`,
              })

              const data = await ipfs.dag.get(out.cid)
              return data.value
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
              const resolvedCid = await ipfs.dag.resolve(merkleCid, {
                path: key,
              })

              const rawData = await ipfs.dag.get(resolvedCid.cid)
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
                  const cid = await ipfs.dag.resolve(merkleCid, {
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
                merkleCid = await ipfs.object.patch.addLink(merkleCid, {
                  Name: brokenPath.path,
                  Hash: CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'),
                })

                merkleCid = await ipfs.object.patch.addLink(merkleCid, {
                  Name: `${brokenPath.path}/.self`,
                  Hash: brokenPath.cid,
                })
              } else {
                merkleCid = await ipfs.object.patch.addLink(merkleCid, {
                  Name: brokenPath.path,
                  Hash: CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'),
                })
              }
            }

            const dataCid = await ipfs.dag.put(value)
            const stat = await ipfs.block.stat(dataCid)

            merkleCid = (
              await addLink(ipfs, {
                parentCid: merkleCid,
                name: key,
                size: stat.size,

                cid: dataCid,
                hashAlg: 'sha2-256',
                cidVersion: 1,
                flush: true,
                shardSplitThreshold: 2_000,
              })
            ).cid

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
            const pBufNode = await ipfs.object.get(`${stateCid}/${key}` as any)
            console.log(pBufNode.Links)
            return pBufNode.Links.map((e) => e.Name)
          } catch {
            return []
          }
        },
        del: async (key) => {
          if (!key) {
            return
          }
          let merkleCid = stateCid
          //To be implemented!
          merkleCid = await removeLink(ipfs, {
            parentCid: merkleCid,
            name: key,
            size: 0,

            hashAlg: 'sha2-256',
            cidVersion: 1,
            flush: true,
            shardSplitThreshold: 2_000,
          })
          stateCid = merkleCid
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

  async initiate() {}

  async testRun() {}

  registerBindings() {}
}

/**
 * Container class for VM execution
 */
class VmRunner {
  balanceDb: Collection
  ledgerDb: Collection

  ledgerStack: LedgerType[]
  ledgerStackTemp: LedgerType[]
  outputStack: any[]
  balanceSnapshots: Map<string, any>

  state: any
  modules: any

  constructor(args) {
    this.state = args.state
    this.modules = args.modules

    this.ledgerStack = []
    //Temporary ledger stack for use in contract execution. Pushed to ledgerStack for permanent storage
    this.ledgerStackTemp = []
    this.outputStack = []
    this.balanceSnapshots = new Map()
  }

  /**
   * Gets direct original balance snapshot without applied transfers
   * DO NOT USE this in contract execution directly
   * @param account 
   * @param block_height 
   * @returns 
   */
  private async getBalanceSnapshotDirect(args: {
    account: string
    tag?: string
  }, block_height: number) {
    const {account, tag} = args
    const lastBalance = await this.balanceDb.findOne({ account: account })

    const balanceTemplate = lastBalance
      ? {
          account: account,
          tag: tag,
          tokens: {
            HIVE: lastBalance.tokens.HIVE,
            HBD: lastBalance.tokens.HBD,
          },
          block_height: block_height,
        }
      : {
          account: account,
          tag: tag,
          tokens: {
            HIVE: 0,
            HBD: 0,
          },
          block_height: block_height,
        }

    const hiveDeposits = await this.ledgerDb
      .find(
        {
          unit: 'HIVE',
          owner: account,
          tag: tag,
        },
        {
          sort: {
            block_height: 1,
          },
        },
      )
      .toArray()

    const hbdDeposits = await this.ledgerDb
      .find(
        {
          unit: 'HBD',
          owner: account,
          tag: tag,
        },
        {
          sort: {
            block_height: 1,
          },
        },
      )
      .toArray()

    const hiveAmount = hiveDeposits
      .map((e) => e.amount)
      .reduce((acc, cur) => {
        return acc + cur
      }, balanceTemplate.tokens.HIVE)

    const hbdAmount = hbdDeposits
      .map((e) => e.amount)
      .reduce((acc, cur) => {
        return acc + cur
      }, balanceTemplate.tokens.HBD)

    return {
      account: account,
      tokens: {
        HIVE: hiveAmount,
        HBD: hbdAmount,
      },
      block_height: block_height,
    }
  }

  /**
   * 
   * @param account 
   * @param block_height 
   * @returns 
   */
  async getBalanceSnapshot(account: string, block_height: number) { 
    if(this.balanceSnapshots.has(account)) { 
      const balance = this.balanceSnapshots.get(account)
      const combinedLedger = [...this.ledgerStack, ...this.ledgerStackTemp]
      const hbdBal = combinedLedger.filter(e => e.amount && e.unit === 'HBD').map(e => e.amount).reduce((acc, cur) => acc + cur, balance.token['HBD'])
      const hiveBal = combinedLedger.filter(e => e.amount && e.unit === 'HIVE').map(e => e.amount).reduce((acc, cur) => acc + cur, balance.token['HIVE'])

      return {
        account: account,
        tokens: {
          HIVE: hiveBal,
          HBD: hbdBal
        },
        block_height: block_height,
      }
    } else {
      const balanceSnapshot = await this.getBalanceSnapshotDirect({account}, block_height);
      this.balanceSnapshots.set(account, balanceSnapshot)
      return balanceSnapshot
    }
  }

  applyLedgerOp(op: LedgerType) {
    console.log('applyLedgerOp', op)
    this.ledgerStackTemp.push(op)
  }

  /**
   * Saves ledger to perm memory
   * TODO: create updated balance snapshot
   */
  saveLedger() {
    this.ledgerStack.push(...this.ledgerStackTemp)
    this.ledgerStackTemp = []
  }

  /**
   * Create a shortened ledger for indexing purposes
   */
  // shortenLedger() {
  //   let collected = this.ledgerStack.reduce((acc, cur) => { 
  //     if(acc[cur.account]) {
  //       acc[cur.account] = null
  //     } else {
  //       acc[cur.account] = null
  //     }
  //     return acc
  //   }, {})
  //   const ownerList = Object.keys(collected)
  //   let shortenedLedger = []
  //   for(let owner of ownerList) {
  //     const hiveDiff = this.ledgerStack.filter(e => e.account === owner && e.token === 'HIVE').map(e => e.amount).reduce((acc, cur) => acc + cur, 0)
  //     const hbdDiff = this.ledgerStack.filter(e => e.account === owner && e.token === 'HBD').map(e => e.amount).reduce((acc, cur) => acc + cur, 0)
  //     if(hbdDiff === 0) {
  //       shortenedLedger.push({
  //         account: owner,
  //         amount: hbdDiff,
  //         token: 'HBD'
  //       })
  //     }
  //     if(hiveDiff) {
  //       shortenedLedger.push({
  //         account: owner,
  //         amount: hiveDiff,
  //         token: 'HIVE'
  //       })
  //     }
  //   }
  //   return shortenedLedger
  // }



  /**
   * Init should only be called once
   */
  async init() {
    const connection = new MongoClient(process.env.MONGODB_URL || 'mongodb://localhost:27017')
    await connection.connect()
    const db = connection.db('vsc-new')
    this.balanceDb = db.collection('bridge_balances')
    this.ledgerDb = db.collection('bridge_ledger')

    let modules = {}
    for (let [contract_id, code] of Object.entries<string>(this.modules)) {
      const binaryData = await ipfs.block.get(IPFS.CID.parse(code))
      modules[contract_id] = await WebAssembly.compile(binaryData)
    }

    let state = {}
    for (let [contract_id, stateCid] of Object.entries<string>(this.state)) {
      const wasmRunner = new WasmRunner()
      const stateAccess = await wasmRunner.contractStateRaw(contract_id, stateCid)
      state[contract_id] = {
        wasmRunner,
        stateAccess,
      }
    }
    this.state = state;
    this.modules = modules;
  }

  /**
   * Executes a smart contract operation
   */
  async executeCall(args: { 
    contract_id: string; 
    action: string; 
    payload: string 
    env: {
      'anchor.id': string
      'anchor.block': string
      'anchor.timestamp': number
      'anchor.height': number

      'msg.sender': string
      'msg.required_auths': Array<string>
      'tx.origin': string
    }
    block_height: number
  }) {
    const contract_id = args.contract_id
    const memory = new WebAssembly.Memory({
      initial: 10,
      maximum: 128,
    })

    let IOGas = 0
    let error
    const logs = []
    const { wasmRunner, stateAccess } = this.state[contract_id]

    const contractEnv = {
      ...args.env
      //Fill in with custom args or anything else in the future.
    }

    /**
     * Contract System calls
     */
    const contractCalls = {
      'crypto.sha256': (value) => {
        return sha256(Buffer.from(value, 'hex')).toString('hex')
      },
      'crypto.ripemd160': (value) => {
        return ripemd160(Buffer.from(value, 'hex')).toString('hex')
      },
      //Gets current balance of contract account or tag
      //Cannot be used to get balance of other accounts (or generally shouldn't)
      'hive.getbalance': async (value) => { 
        const args: {
          account: string
          tag?: string
        } = JSON.parse(value)
        const snapshot = await this.getBalanceSnapshot(`${args.account}${args.tag ? '#' + args.tag.replace('#', '') : ''}`, 84021084)

        return {
          result: snapshot.tokens
        }
      },
      //Pulls token balance from user transction
      'hive.draw': async (value) => { 
        const args:{
          from: string
          amount: number
          asset: "HIVE" | "HBD"
        } = JSON.parse(value)
        const snapshot = await this.getBalanceSnapshotDirect({
          account: args.from
        }, 84021084)
        console.log('snapshot result', snapshot)

        if(snapshot.tokens[args.asset] >= args.amount) {
          this.applyLedgerOp({
            owner: args.from,
            to: contract_id,
            amount: -args.amount,
            unit: args.asset
          })
          this.applyLedgerOp({
            from: args.from,
            owner: contract_id,
            amount: args.amount,
            unit: args.asset
          })
          console.log(this.ledgerStackTemp)
          return {
            result: "SUCCESS"
          }
        } else {
          return {
            result: "INSUFFICIENT_FUNDS"
          }
        }
      },
      //Transfer tokens owned by contract to another user or 
      'hive.transfer': async(value) => { 
        const args: {
          dest: string
          amount: number
          asset: "HIVE" | "HBD"
        } = JSON.parse(value)
        const snapshot = await this.getBalanceSnapshotDirect({
          account: contract_id
        }, 84021084)
        if(snapshot.tokens[args.asset] >= args.amount) { 


        } else {
          return {
            result: "INSUFFICIENT_FUNDS"
          }
        }
        
      },
      //Triggers withdrawal of tokens owned by contract
      'hive.withdraw': async (value) => { 
        const args:{
          dest: string
          amount: number
          asset: "HIVE" | "HBD"
        } = JSON.parse(value)
        const snapshot = await this.getBalanceSnapshotDirect({
          account: contract_id
        }, 84021084)
        console.log('snapshot result', snapshot)

        if(snapshot.tokens[args.asset] >= args.amount) {
          this.applyLedgerOp({
            owner: contract_id,
            to: '#withdraw',
            amount: -args.amount,
            unit: args.asset,
            dest: args.dest
          })
          // this.applyLedgerOp({
          //   from: contract_id,
          //   to: '#withdraw',
          //   dest: args.dest,
          //   amount: args.amount,
          //   unit: args.asset
          // })
          console.log(this.ledgerStackTemp)
          return {
            result: "SUCCESS"
          }
        } else {
          return {
            result: "INSUFFICIENT_FUNDS"
          }
        }
      }
    }

    try {
      const insta = await instantiate(this.modules[contract_id], {
        env: {
          memory,
          abort(msg, file, line, colm) {
            error = {
              msg: insta.exports.__getString(msg),
              file: insta.exports.__getString(file),
              line,
              colm,
            }
          },
          //Prevent AS loader from allowing any non-deterministic data in.
          //TODO: Load in VRF seed for use in contract
          seed: () => {
            return 0
          },
        },
        //Same here
        Date: {},
        Math: {},
        sdk: {
          'revert': () => {
            //Revert entire TX and any lower level function calls
          },
          'console.log': (keyPtr) => {
            const logMsg = (insta as any).exports.__getString(keyPtr)
            logs.push(logMsg)
            IOGas = IOGas + logMsg.length
          },
          'console.logNumber': (val) => {
            logs.push(val)
          },
          'console.logBool': (val) => {
            logs.push(Boolean(val))
          },
          'db.setObject': (keyPtr, valPtr) => {
            const key = (insta as any).exports.__getString(keyPtr)
            const val = (insta as any).exports.__getString(valPtr)

            IOGas = IOGas + key.length + val.length

            wasmRunner.stateCache.set(key, val)
            return 1
          },
          'db.getObject': async (keyPtr) => {
            const key = (insta as any).exports.__getString(keyPtr)
            let value
            if (wasmRunner.stateCache.has(key)) {
              value = wasmRunner.stateCache.get(key)
            } else {
              value = await stateAccess.client.pull(key)
              wasmRunner.stateCache.set(key, value)
            }

            const val = JSON.stringify(value)

            IOGas = IOGas + val.length // Total serialized length of gas

            return insta.exports.__newString(val)
          },
          'db.delObject': async (keyPtr) => {
            const key = (insta as any).exports.__getString(keyPtr)
            wasmRunner.stateCache.set(key, null)
          },
          'system.call': async (callPtr, valPtr) => {
            const callArg = insta.exports.__getString(callPtr)
            const valArg = JSON.parse(insta.exports.__getString(valPtr))

            let resultData
            if (typeof contractCalls[callArg] === 'function') {
              resultData = JSON.stringify({
                //Await should be there if function is async. Otherwise it's fine
                result: await contractCalls[callArg](valArg.arg0),
              })
            } else {
              resultData = JSON.stringify({
                err: 'INVALID_CALL',
              })
            }

            return insta.exports.__newString(resultData)
          },
          'system.getEnv': async (envPtr) => {
            const envArg = insta.exports.__getString(envPtr)

            return insta.exports.__newString(
              typeof contractEnv[envArg] === 'string' ? contractEnv[envArg] : JSON.stringify(contractEnv[envArg])
            )
          },
        },
      } as any)

      if (!insta.instance.exports[args.action]) {
        return {
          type: 'execute-stop',
          ret: null,
          errorType: ContractErrorType.INVALID_ACTION,
          logs,
          // reqId: message.reqId,
          IOGas: 0,
        }
      }
      let ptr
      try {
        ptr = await (insta.instance.exports[args.action] as any)(
          (insta as any).exports.__newString(args.payload),
        )

        const str = (insta as any).exports.__getString(ptr)

        //Assume successful, save any ledger results.
        this.saveLedger()

        //For testing determining use..

        return {
          type: 'execute-stop',
          ret: str,
          logs,
          // reqId: message.reqId,
          IOGas,
        }
      } catch (ex) {
        if (ex.name === 'RuntimeError' && ex.message === 'unreachable') {
          console.log(`RuntimeError: unreachable ${JSON.stringify(error)}`, error)
          return {
            type: 'execute-stop',
            ret: null,
            error: error,
            errorType: ContractErrorType.RUNTIME_EXCEPTION,
            logs,
            // reqId: message.reqId,
            IOGas,
          }
        } else {
          return {
            type: 'execute-stop',
            ret: null,
            errorType: ContractErrorType.RUNTIME_UNKNOWN,
            logs,
            // reqId: message.reqId,
            IOGas,
          }
        }
      }
    } catch (ex) {
      console.log('failed runtime setup', ex)
      return {
        type: 'execute-stop',
        ret: null,
        logs,
        errorType: ContractErrorType.RUNTIME_SETUP,
        // reqId: message.reqId,
        IOGas,
      }
    }
  }

  async *finish() {
    let entries = Object.entries<{
      wasmRunner: any
      stateAccess: any
    }>(this.state)
    for (let index in entries) {
      const [contract_id, entry] = entries[index]
      const { wasmRunner, stateAccess } = entry
      for (let [key, value] of wasmRunner.stateCache.entries()) {
        //Try catch safety
        try {
          if (value === null) {
            //Assume deleted
            await stateAccess.client.del(key)
          } else {
            await stateAccess.client.update(key, JSON.parse(value))
          }
        } catch {}
      }
      console.log('sending result')
      yield {
        type: 'partial-result',
        contract_id,
        index,
        stateMerkle: stateAccess.finish().stateMerkle.toString(),
        ledgerResults: this.ledgerStack
      }
    }
    yield {
      type: 'finish-result'
    }
  }
}

void (async () => {
  const vmRunner = new VmRunner({
    state: JSON.parse(process.env.state),
    modules: JSON.parse(process.env.modules),
  })

  await vmRunner.init()

  process.send({
    type: 'ready',
  })

  process.on('message', async (message: any) => {
    if (message.type === 'call') {
      const executeResult = await vmRunner.executeCall({
        contract_id: message.contract_id,
        payload: message.payload,
        action: message.action,
        //Fill these in soon
        env: message.env,
        block_height: 84021084
      })
      process.send({
        ...executeResult,
        reqId: message.reqId,
      })
    }

    //Finalization when VM is done
    if (message.type === 'finish') {
      for await (let result of vmRunner.finish()) {
        process.send(result)
      }
    }
  })
})()
