import * as IPFS from 'kubo-rpc-client'
import sift, { BasicValueQuery, Query } from 'sift'

import { Collection, MongoClient } from 'mongodb'
import { addLink } from '../../../ipfs-utils/add-link.js'
import { removeLink } from '../../../ipfs-utils/rm-link.js'
import { ContractErrorType, instantiate } from './utils.js'

//Crypto imports
import { ripemd160, sha256 } from 'bitcoinjs-lib/src/crypto.js'
import { EventOp, EventOpType, type AnyReceivedMessage, type AnySentMessage, type Env, type ExecuteStopMessage, type FinishResultMessage, type PartialResultMessage, type ReadyMessage } from './types.js'
import { CID } from 'multiformats'


const ipfs = IPFS.create({ url: process.env.IPFS_HOST || 'http://127.0.0.1:5001' })




const intentFieldMap = {
  'hive.allow_transfer': { 
    limit: 'number',
    token: 'string'
  }
}

function transformIntentField(intentName, fieldName, value) {
  if(intentFieldMap[intentName] && intentFieldMap[intentName][fieldName]) { 
    switch(intentFieldMap[intentName][fieldName]) { 
      case 'number':
        return parseInt(value)
      case 'string':
        return value.toString()
      case 'boolean': 
        return Boolean(value)
    }
  } else {
    return value
  }
}

export class StateCache {
  stateCache: Map<string, any>
  opCache: Map<string, any>
  stateMerkle: CID
  //State Merkle for initialization
  constructor(stateMerkle: string) {

    this.stateMerkle = CID.parse(stateMerkle)

    //Permanent memory cache for state
    this.stateCache = new Map()

    //Temp memory cache for state. IF contract execution fails, this is reverted
    this.opCache = new Map()


    // this.lsCache = new Map()
  }


  /**
   * Finalize the state
   */
  finishOp() {
    for(let [key, value] of this.opCache.entries()) { 
      this.stateCache.set(key, value)
    }
    this.opCache.clear();
  }

  
  revertState() {
    this.opCache.clear()
  }

  async finalizeState(): Promise<CID> {
    //In the future we could introduce batching to prevent many write operations
    //stateCache gets mirrored to IPFS state
    for(let [key, value] of this.stateCache.entries()) { 
      if(value === null) {
        await this.#del(key)
      } else {
        await this.#put(key, value)
      }
    }
    return this.stateMerkle
  }

  async #get (key: string) {
    const ts = new Date();
    try {
      const out = await ipfs.dag.resolve(this.stateMerkle, {
        path: key,
      })

      const data = await ipfs.dag.get(out.cid)

      if (out.cid.code === 0x70) {
        //If accidentally requesting PD-dag
        const out = await ipfs.dag.resolve(this.stateMerkle, {
          path: `${key}/.self`,
        })

        const data = await ipfs.dag.get(out.cid)
        console.log('Finished pull ts.ms', new Date().getTime() -  ts.getTime(), 'ms')
        return data.value
      } else if (out.cid.code === 0x71) {
        //CBOR dag
        console.log('Finished pull ts.ms', new Date().getTime() -  ts.getTime(), 'ms')
        return data.value
      } else {
        //This shouldn't happen unless other issues are present.
        console.log('Finished pull ts.ms', new Date().getTime() -  ts.getTime(), 'ms')
        return null
      }
    } catch (ex) {
      console.log(ex)
      console.log('Finished pull ts.ms', new Date().getTime() -  ts.getTime(), 'ms')
      return null
    }
  }

  async #put(key: string, value: string) {
    const ts = new Date();

    try {
      if (!value) {
        return
      }

      let linkExists
      let dagData
      let brokenPaths: ({
        path: string,
        cid: IPFS.CID,
        wrongFormat: true,
      } | {
        path: string, 
        wrongFormat?: never,
      })[] = []
      try {
        const resolvedCid = await ipfs.dag.resolve(this.stateMerkle, {
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
            const cid = await ipfs.dag.resolve(this.stateMerkle, {
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
          this.stateMerkle = await ipfs.object.patch.addLink(this.stateMerkle, {
            Name: brokenPath.path,
            // @ts-ignore weird deps CID types don't. no need to worry about it
            Hash: CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'),
          })

          this.stateMerkle = await ipfs.object.patch.addLink(this.stateMerkle, {
            Name: `${brokenPath.path}/.self`,
            // @ts-ignore weird deps CID types don't. no need to worry about it
            Hash: brokenPath.cid,
          })
        } else {
          this.stateMerkle = await ipfs.object.patch.addLink(this.stateMerkle, {
            Name: brokenPath.path,
            // @ts-ignore weird deps CID types don't. no need to worry about it
            Hash: CID.parse('QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn'),
          })
        }
      }

      const dataCid = await ipfs.dag.put(value)
      const stat = await ipfs.block.stat(dataCid)

      this.stateMerkle = (
        await addLink(ipfs, {
          parentCid: this.stateMerkle,
          name: key,
          size: stat.size,

          cid: dataCid,
          hashAlg: 'sha2-256',
          cidVersion: 1,
          flush: true,
          shardSplitThreshold: 2_000,
        })
      ).cid

    } catch (ex) {
      console.log(ex)
    }

    console.log('Update ts.ms', new Date().getTime() -  ts.getTime(), 'ms')
    //TODO make this happen after contract call has been completely executed
    //stateCid = obj;
  }

  async #ls(prefix: string) {
    const ts = new Date();
    try {
      const pBufNode = await ipfs.object.get(`${this.stateMerkle}/${prefix}` as any)
      console.log(pBufNode.Links)
      console.log('Ls ts.ms', new Date().getTime() -  ts.getTime(), 'ms')
      return pBufNode.Links.map((e) => e.Name)
    } catch {
      return []
    }
  }


  async #del(key: string) {
    if (!key) {
      return
    }
    //To be implemented!
    this.stateMerkle = (await removeLink(ipfs, {
      parentCid: this.stateMerkle,
      name: key,
      size: 0,

      hashAlg: 'sha2-256',
      cidVersion: 1,
      flush: true,
      shardSplitThreshold: 2_000,
    })).cid
  }



  async get(key: string) {
    if(this.opCache.has(key)) { 
      return this.opCache.get(key)
    } else if(this.stateCache.has(key)) { 
      return this.stateCache.get(key)
    } else {
      const value = await this.#get(key)
      this.stateCache.set(key, value)
      return value
    }
  }

  async set(key: string, value: string) {
    this.opCache.set(key, value)
    
  }

  /**
   * This might be problematic for large directories.
   * Research better ways to do this. (might include in memory HAMT)
   * Not used yet
   * @param prefix 
   * @returns 
   */
  async ls(prefix: string) {
    const keys = new Map()

    //TODO: Pull keys from HAMT permanent state
    

    for(let [key, value] of this.stateCache.entries()) { 
      if(key.startsWith(prefix)) { 
        if(value === null) {
          keys.delete(key)
        } else {
          keys.set(key, '1')
        }
      }
    }
    for(let [key, value] of this.opCache.entries()) { 
      if(key.startsWith(prefix)) { 
        if(value === null) {
          keys.delete(key)
        } else {
          keys.set(key, '1')
        }
      }
    }




    
    return this.#ls(prefix)
  }
  
  async del(key: string) {
    this.opCache.set(key, null)
  }
}

/**
 * Container class for VM execution
 */
class VmRunner {
  balanceDb: Collection
  ledgerDb: Collection
  contractOuputs: Collection

  ledgerStack: EventOp[]
  outputStack: any[]
  balanceSnapshots: Map<string, any>

  state: Record<string, {
    stateCache: StateCache
    stateCid: string
  } | undefined>
  modules: any
  intents: Array<{
    name: string
    args: Record<string, any>
  }>

  op: null | {
    block_height: number
  }

  constructor(args) {
    this.state = args.state
    this.modules = args.modules

    this.ledgerStack = []
    this.outputStack = []
    this.balanceSnapshots = new Map()

    this.op = null
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
      // const combinedLedger = [...this.ledgerStack, ...this.ledgerStackTemp]
      const hbdBal = this.ledgerStack.filter(e => e.amt && e.tk === 'HBD').map(e => e.amt).reduce((acc, cur) => acc + cur, balance.tokens['HBD'])
      const hiveBal = this.ledgerStack.filter(e => e.amt && e.tk === 'HIVE').map(e => e.amt).reduce((acc, cur) => acc + cur, balance.tokens['HIVE'])

      return {
        account: account,
        tokens: {
          HIVE: balance.HIVE + hiveBal,
          HBD: balance.HBD + hbdBal
        },
        block_height: block_height,
      }
    } else {
      const balanceSnapshot = await this.getBalanceSnapshotDirect({account}, block_height);
      this.balanceSnapshots.set(account, balanceSnapshot)
      return balanceSnapshot
    }
  }

  
  setBalances(balances: Object) {
    this.balanceSnapshots = new Map(Object.entries(balances))
  }

  applyLedgerOp(op: EventOp) {
    this.ledgerStack.push(op)

  }

  /**
   * Saves ledger to perm memory
   * TODO: create updated balance snapshot
   */
  // saveLedger() {
  //   this.ledgerStack.push(...this.ledgerStackTemp)
  //   this.ledgerStackTemp = []
  // }

  /**
   * Revert current OP
   * TODO: reset remote call stack when implemented
   */
  revertOp() {
    this.ledgerStack = []
    for(let [, {stateCache} = {stateCache: undefined}] of Object.entries(this.state)) { 
      stateCache?.revertState()
    }
  }

  finishOp() {
    // this.saveLedger()
    const ledger = [...this.ledgerStack]
    this.ledgerStack = []

    for(let [, {stateCache} = {stateCache: undefined}] of Object.entries(this.state)) { 
      stateCache?.finishOp()
    }
    return {
      ledger
    }
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
   * Verifies intent meets header condition
   * @param name
   * @param conditions 
   * @returns 
   */
  verifyIntent(name: string, conditions?: Record<
    string,
    Query<string | number>
    >): boolean {

    console.log('verifying INTENT', this.intents)


    intentLoop: for(let intent of this.intents) { 
      if(intent.name !== name) {
        continue;
      }
  
      for(let conditionName in conditions) {
        const filterData = conditions[conditionName]
        const filter = sift(filterData)
        
        if(!filter(
          intent.args[conditionName]
        )) {
          continue intentLoop;
        }
      }
      return true;
    }
    return false;
  }


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
      const cid = IPFS.CID.parse(code)
      const binaryData = await (async () => {
        switch (cid.code) {
          case 0x71:
            return (await ipfs.dag.get(cid)).value
          case 0x55:
            return await ipfs.block.get(cid)
        }
      })()
      try {
        modules[contract_id] = await WebAssembly.compile(binaryData)
      } catch (e) {
        console.error(`invalid contract code ${contract_id}`, e)
      }
    }

    let state = {}
    for (let [contract_id, {stateCid} = {stateCid: undefined}] of Object.entries(this.state)) {
      if (!stateCid) {
        continue;
      }
      const stateCache = new StateCache(stateCid)
      state[contract_id] = {
        stateCache
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
    intents: Array<string>
    env: Env
    block_height: number
  }): Promise<Omit<ExecuteStopMessage, 'reqId'>> {
    const contract_id = args.contract_id
    const block_height = args.block_height

    this.intents = (args.intents || []).map(e => {
      const [name, queryParam] = e.split('?')

      const paramters = {}
      new URLSearchParams(queryParam).forEach((value, key) => { 
        console.log(name, key, value)
        paramters[key] = transformIntentField(name, key, value)
      })
      
      return {
        name: name,
        args: paramters
      }
    })


    const memory = new WebAssembly.Memory({
      initial: 10,
      maximum: 12800,
    })

    let IOGas = 0
    let error
    const logs: (string | boolean | number)[] = []
    const state = this.state[contract_id]
    if (!state) {
      return {
        type: 'execute-stop',
        ret: null,
        error: 'missing contract',
        errorType: ContractErrorType.INVALID_CONTRACT,
        logs: [],
        IOGas: 0,
        ledger: []
      }
    }
    const { stateCache } = state

    const contractEnv = {
      ...args.env,
      //Fill in with custom args or anything else in the future.
      contract_id
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
        const snapshot = await this.getBalanceSnapshot(`${args.account}${args.tag ? '#' + args.tag.replace('#', '') : ''}`, block_height)



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
          tag?: string
        } = JSON.parse(value)
        const snapshot = await this.getBalanceSnapshot(args.from, block_height)

        //Total amount drawn from ledgerStack during this execution
        const totalAmountDrawn = Math.abs(this.ledgerStack.filter(sift({
          owner: args.from,
          to: contract_id,
          unit: args.asset
        })).reduce((acc, cur) => acc + cur.amt, 0))


        

        const allowedByIntent = this.verifyIntent('hive.allow_transfer', {
          token: {
            $eq: args.asset.toLowerCase()
          },
          limit: {
            $gte: args.amount + totalAmountDrawn
          }
        })


        if(!allowedByIntent) {
          return {
            result: "MISSING_INTENT_HEADER" 
          }
        }

        if(snapshot.tokens[args.asset] >= args.amount) {
          this.applyLedgerOp({
            t: EventOpType['ledger:transfer'],
            owner: args.from,
            amt: -args.amount,
            tk: args.asset
          })
          this.applyLedgerOp({
            t: EventOpType['ledger:transfer'],
            //Tag using contract address #tag
            owner: args.tag ? `${contract_id}#${args.tag}` : contract_id,
            amt: args.amount,
            tk: args.asset
          })
          
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
          //$self#tag
          dest: string
          //Transfer tag
          from_tag?: string
          memo?: string
          amount: number
          asset: "HIVE" | "HBD"
        } = JSON.parse(value)
        let normalizedFrom = args.from_tag ? `${contract_id}#${args.from_tag}` : contract_id
        let normalizedDest;

        if(!['HIVE', 'HBD'].includes(args.asset)) { 
          return {
            result: "INVALID_ASSET"
          }
        }

        if(args.dest === '$self') { 
          const [, tag] = args.dest.split('#')
          normalizedDest = tag ? `${contract_id}#${tag}` : contract_id 
        } else {
          if(args.dest.startsWith('did:') || args.dest.startsWith('hive:')) { 
            normalizedDest = args.dest
          } else {
            return {
              result: "INVALID_DEST"
            }
          }
        }
        const snapshot = await this.getBalanceSnapshot(normalizedFrom, block_height)
        if(snapshot.tokens[args.asset] >= args.amount) { 
          this.applyLedgerOp({
            t: EventOpType['ledger:transfer'],
            owner: normalizedFrom,
            amt: -args.amount,
            tk: args.asset
          })

          this.applyLedgerOp({
            t: EventOpType['ledger:transfer'],
            owner: normalizedDest,
            amt: args.amount,
            tk: args.asset,
            //Memo will always be in last op to save space. Indexing makes it easier to search for memos
            ...(args.memo ? {memo: args.memo} : {})
          })

          return {
            result: "SUCCESS"
          }
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
          from_tag?: string
          memo?: string
          amount: number
          asset: "HIVE" | "HBD"
        } = JSON.parse(value)
        let normalizedFrom = args.from_tag ? `${contract_id}#${args.from_tag}` : contract_id
        let normalizedDest;

        if(!['HIVE', 'HBD'].includes(args.asset)) { 
          return {
            result: "INVALID_ASSET"
          }
        }
        
        if(args.dest.startsWith('hive:')) { 
          normalizedDest = args.dest
        } else {
          return {
            result: "INVALID_DEST"
          }
        }

        const snapshot = await this.getBalanceSnapshot(normalizedFrom, block_height)
        console.log('snapshot result', snapshot)

        if(snapshot.tokens[args.asset] >= args.amount) {
          this.applyLedgerOp({
            t: EventOpType['ledger:withdraw'],
            owner: normalizedFrom,
            amt: -args.amount,
            tk: args.asset,
          })
          this.applyLedgerOp({
            t: EventOpType['ledger:withdraw'],
            owner: `#withdraw?to=${normalizedDest}`,
            amt: args.amount,
            tk: args.asset,
            ...(args.memo ? {memo: args.memo} : {})
          })
          console.log(this.ledgerStack)
          return {
            result: "SUCCESS"
          }
        } else {
          return {
            result: "INSUFFICIENT_FUNDS"
          }
        }
      },
      //Intercontract read
      'ic.read': async (contractId: string, key: string, value: string) => { 
        if(this.state[contractId]) { 
          const state = this.state[contractId]
          const {stateCache} = state
          const result = await stateCache.get(key)
          return result
        } else {
          const contractOutput = await this.contractOuputs.findOne({
            contractId: contractId,
            anchored_height: {
              $lte: this.op.block_height
            }
          }, {
            //Latest height
            sort: {
              anchored_height: -1
            }
          })
          console.log('contractOutput', contractOutput)

          const stateCache = new StateCache(contractOutput.state_merkle)
          this.state[contractId] = {
            stateCache,
            stateCid: contractOutput.state_merkle
          }
          const result = await stateCache.get(key)
          return result
        }
      },
      //Intercontract write
      'ic.call': async (value) => { 

      },
      //Links contract for writes in the future
      //It is required to link a contract first to allow for VM loading
      //In the future, links can be dynamically set within the sending TX itself to ensure proper gas is allocated
      //..and vm is loaded properly
      'ic.link': async (value) => { 

      },
      //Unlinks intercontract call
      'ic.unlink': async (value) => { 

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
            this.revertOp()
          },
          'console.log': (keyPtr) => {
            const logMsg = insta.exports.__getString(keyPtr)
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
            const key = insta.exports.__getString(keyPtr)
            const val = insta.exports.__getString(valPtr)

            IOGas = IOGas + key.length + (val?.length || 0)

            stateCache.set(key, val)
            return 1
          },
          'db.getObject': async (keyPtr) => {
            const key = insta.exports.__getString(keyPtr)
            let value = await stateCache.get(key)


            const val = JSON.stringify(value)

            IOGas = IOGas + val.length // Total serialized length of gas

            return insta.exports.__newString(val)
          },
          'db.delObject': async(keyPtr) => {
            const key = insta.exports.__getString(keyPtr)
            await stateCache.del(key)
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
          'system.getEnv': (envPtr) => {
            const envArg = insta.exports.__getString(envPtr)

            return insta.exports.__newString(
              typeof contractEnv[envArg] === 'string' ? contractEnv[envArg] : JSON.stringify(contractEnv[envArg])
            )
          },
        },
      })

      if (!insta.instance.exports[args.action]) {
        return {
          type: 'execute-stop',
          ret: null,
          error: null,
          errorType: ContractErrorType.INVALID_ACTION,
          logs,
          // reqId: message.reqId,
          IOGas: 0,
          ledger: []
        }
      }
      let ptr
      try {
        ptr = await (insta.instance.exports[args.action] as any)(
          insta.exports.__newString(args.payload),
        )

        const str = insta.exports.__getString(ptr)

        //Assume successful, save any ledger results.
        const {ledger} = this.finishOp()

        //For testing determining use..

        return {
          type: 'execute-stop',
          ret: str,
          logs,
          error: null,
          errorType: null,
          // reqId: message.reqId,
          IOGas,
          ledger
        }
      } catch (ex) {
        if (ex.name === 'RuntimeError' && ex.message === 'unreachable') {
          console.log(`RuntimeError: unreachable ${JSON.stringify(error)}`, error)

          this.revertOp()
          return {
            type: 'execute-stop',
            ret: null,
            error: error,
            errorType: ContractErrorType.RUNTIME_EXCEPTION,
            logs,
            // reqId: message.reqId,
            IOGas,
            ledger: []
          }
        } else {
          this.revertOp()
          return {
            type: 'execute-stop',
            ret: null,
            error: ex.toString() + ' ' + ex.stack,
            errorType: ContractErrorType.RUNTIME_UNKNOWN,
            logs,
            // reqId: message.reqId,
            IOGas,
            ledger: []
          }
        }
      }
    } catch (ex) {
      console.log('failed runtime setup', ex)
      return {
        type: 'execute-stop',
        ret: null,
        logs,
        error: ex.toString(),
        errorType: ContractErrorType.RUNTIME_SETUP,
        // reqId: message.reqId,
        IOGas,
        ledger: []
      }
    }
  }

  async *finish(): AsyncGenerator<PartialResultMessage | FinishResultMessage> {
    let entries = Object.entries(this.state)
    for (let index in entries) {
      const [contract_id, entry] = entries[index]
      if (!entry) {
        continue;
      }
      const { stateCache } = entry
      const stateMerkle = await stateCache.finalizeState()
      console.log('sending result')
      yield {
        type: 'partial-result',
        contract_id,
        index,
        stateMerkle: stateMerkle.toString()
      }
    }
    yield {
      type: 'finish-result'
    }
  }
}

void (async () => {
  if (!process.env.state) {
    throw new Error('`state` not in environment. vm-runner is called wrong')
  }
  if (!process.env.modules) {
    throw new Error('`modules` not in environment. vm-runner is called wrong')
  }
  if (!process.send) {
    throw new Error('vm-runner not called as a Node.JS sub-process')
  }
  const stateParsed = JSON.parse(process.env.state)
  let state = {}
  for (let [contract_id, stateCid] of Object.entries(stateParsed)) {
    state[contract_id] = {
      stateCid,
    }
  }
  const vmRunner = new VmRunner({
    state: state,
    modules: JSON.parse(process.env.modules),
  })

  await vmRunner.init()

  process.send({
    type: 'ready',
  } satisfies AnyReceivedMessage)

  process.on('message', async (message: AnySentMessage) => {
    if (message.type === 'call') {

      vmRunner.setBalances(message.balance_map)
      
      const executeResult = await vmRunner.executeCall({
        contract_id: message.contract_id,
        payload: message.payload,
        action: message.action,
        //Fill these in soon
        intents: message.intents,
        env: message.env,
        block_height: message.env['anchor.height']
      })
      process.send!({
        ...executeResult,
        reqId: message.reqId,
      } satisfies AnyReceivedMessage)
    }

    //Finalization when VM is done
    if (message.type === 'finish') {
      for await (let result of vmRunner.finish()) {
        process.send!(result satisfies AnyReceivedMessage)
      }
      process.exit(0)
    }
  })
})()
