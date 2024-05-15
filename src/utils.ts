
import EventEmitter from 'events'
//import PQueue from 'p-queue'
import { BlockchainMode, BlockchainStreamOptions, Client } from '@hiveio/dhive'
import Pushable from 'it-pushable'
import { DagJWS, DID, JWSSignature } from 'dids'
import PQueue from 'p-queue'
import { IPFSHTTPClient } from 'kubo-rpc-client'
import winston from 'winston'
import Axios from 'axios'
import { getLogger, globalLogger } from './logger'
import * as IPFS from "kubo-rpc-client";
import { Version } from 'multiformats'
import {pathToFileURL} from 'node:url';
import { mongo } from './services/db'
import https from 'node:https'


export function truthy<T>(v: T): v is Exclude<T, false | '' | null | undefined> {
  return !!v
}

export function todo<T>(msg: string): T {
  throw new Error('todo: ' + msg)
}


export const keepAliveAgent = new https.Agent({keepAlive:true});


const HIVE_API = process.env.HIVE_HOST || 'https://hive-api.web3telekom.xyz'

export const HiveClient = new Client(process.env.HIVE_HOST || [HIVE_API, 'https://api.deathwing.me', 'https://anyx.io', 'https://api.openhive.network', 'https://rpc.ausbit.dev'])
export const HiveClient2 = new Client('https://api.hive.blog')

HiveClient.options.agent = keepAliveAgent;

/**
 * Fast Hive streaming API
 * 
 * @TODO Increase chunking size dynamically
 */
export class fastStream {

  replayComplete: boolean
  blockMap?: Record<string, any>

  eventQueue: NodeJS.Timer
  events: EventEmitter
  streamPaused: boolean
  streamOut: Pushable.Pushable<any>
  currentBlock: number
  startBlock: number
  parser_height: number
  endSet: number
  setSize: number
  queue: PQueue
  headHeight: number
  headTracker: NodeJS.Timer
  logger: winston.Logger
  finalStream: NodeJS.ReadableStream
  lastBlockAt: Date
  lastBlock: number
  lastBlockTs: Date
  aborts: Array<AbortController>
  streamOpts: { startBlock: number; endBlock?: number; trackHead?: boolean }

  constructor(queue: PQueue, streamOpts: {
    startBlock: number,
    endBlock?: number
    trackHead?: boolean
  }) {
    this.streamOpts = streamOpts
    this.queue = queue
    this.events = new EventEmitter()
    this.streamOut = Pushable()
    this.lastBlock = streamOpts.startBlock || 1
    this.startBlock = streamOpts.startBlock || 1
    this.parser_height = streamOpts.startBlock || 0
    this.setSize = 50;
    this.endSet = ((streamOpts.endBlock || this.parser_height )- this.parser_height) / this.setSize

    this.blockMap = {}
    this.aborts = []

    this.logger = getLogger({
      prefix: 'faststream',
      printMetadata: true,
      level: 'debug',
    })


    this.startStream = this.startStream.bind(this)
    this.resumeStream = this.resumeStream.bind(this)
    this.pauseStream = this.pauseStream.bind(this)
    this.onDone = this.onDone.bind(this)

    this.events.on('block', (block_height, block) => {
      this.streamOut.push([block_height, block])
    })

    this.eventQueue = setInterval(() => {
      if (this.blockMap?.[this.parser_height]) {
        const block_height = parseInt(this.blockMap[this.parser_height].block_id.slice(0, 8), 16)

        this.parser_height = block_height + 1;
        this.events.emit('block', block_height, this.blockMap[block_height])
        this.lastBlockAt = new Date()
        this.lastBlock = block_height;
        this.lastBlockTs = new Date(this.blockMap[block_height].timestamp + "Z")
        delete this.blockMap[block_height]
      }
      for (let key of Object.keys(this.blockMap ?? {})) {
        if (Number(key) < this.parser_height) {
          delete this.blockMap?.[key]; //Memory safety
        }
      }
    }, 1)

  }

  get calcHeight() {
    if (this.lastBlock && this.lastBlockTs) {
      const ts = new Date().getTime()

      const diff = Math.floor((ts - this.lastBlockTs.getTime()) / 3_000)

      return this.lastBlock + diff;
    } else {
      return null;
    }
  }

  get blockLag() {
    //Simulated blockLag

    if (this.lastBlock && this.lastBlockTs) {
      const ts = new Date().getTime()

      const diff = Math.floor((ts - this.lastBlockTs.getTime()) / 3_000)

      return diff
    } else {
      return null;
    }
  }

  async startStream() {

    this.headTracker = setInterval(async () => {
      this.headHeight = await HiveClient.blockchain.getCurrentBlockNum()
    }, 3000)

    let activeLength = 0
    let finalBlock;
    if (this.endSet > 1) {
      for (let x = 0; x <= this.endSet; x++) {
        // console.log('101', x)
        // console.log('this.endSet', this.endSet)
        this.queue.add(async () => {
          const blocks = await streamHiveBlocks(HIVE_API, {
            count: this.setSize,
            start_block: this.startBlock + x * this.setSize
          })
          console.log('this.lastBlock', this.lastBlock, {
            count: this.setSize,
            start_block: this.startBlock + x * this.setSize,
            blockMapSize: Object.keys(this.blockMap ?? {}).length
          })
          // this.currentBlock = this.currentBlock + this.setSize

          for (let block of blocks) {
            // console.log(block)
            const block_height = parseInt(block.block_id.slice(0, 8), 16)
            // console.log(this.parser_height, block_height)
            if (this.parser_height === block_height) {
              this.parser_height = block_height + 1;

              this.events.emit('block', block_height, block)
              this.lastBlockAt = new Date()
              this.lastBlock = block_height;
              this.lastBlockTs = new Date(block.timestamp + "Z")
            } else if (block_height > this.parser_height && this.blockMap) {
              this.blockMap[block_height] = block
            }
          }
        })
        await this.queue.onSizeLessThan(5)
      }
      await this.queue.onIdle();
    }
    this.logger.debug("ITS IDLE", {
      finalBlock
    })

    const controller = new AbortController();
    const signal = controller.signal;

    this.aborts.push(controller)
    try {
      for await (let block of liveHiveBlocks(HIVE_API, {
        start_block: this.parser_height,
        signal
      })) {
        const block_height = parseInt(block.block_id.slice(0, 8), 16)
        if (this.parser_height === block_height) {
          this.parser_height = block_height + 1;

          this.events.emit('block', block_height, block)
          this.lastBlockAt = new Date()
          this.lastBlock = block_height;
          this.lastBlockTs = new Date(block.timestamp + "Z")
        } else if (block_height > this.parser_height && this.blockMap) {
          this.blockMap[block_height] = block
        }
      }
    } catch (error) {
      clearInterval(this.eventQueue as any)
      this.streamOut.end(error)
    }
  }

  async resumeStream() {
    this.streamPaused = true
  }

  async pauseStream() {
    this.streamPaused = false
    this.events.emit('unpause')
  }

  async killStream() {
    clearInterval(this.eventQueue as any)
    clearInterval(this.headTracker as any)
    this.streamOut.end()
    this.queue.clear()
    this.aborts.forEach((e) => {
      e.abort()
    })
    delete this.blockMap

  }

  async onDone() {
    await this.queue.onIdle();
  }

  async init() {
    if (!this.streamOpts.endBlock) {
      const currentBlock = await HiveClient.blockchain.getCurrentBlock()
      const block_height = parseInt(currentBlock.block_id.slice(0, 8), 16)
      this.streamOpts.endBlock = block_height;
    }
  }

  static async create(streamOpts: { startBlock: number, endBlock?: number, trackHead?: boolean }) {
    const PQueue = (await import('p-queue')).default
    const queue = new PQueue({ concurrency: 2 })
    

    return new fastStream(queue, streamOpts)
  }
}

function parseHiveBlocks(blocksInput) {
  const blocks = blocksInput.map(block => {
    block.transactions = block.transactions.map((tx, index) => {
      tx.operations = tx.operations.map(op => {
        const typeS = op.type.split('_')
        const typeB = typeS.splice(0, typeS.length - 1).join('_');
        if (typeB === 'transfer') {
          let unit;
          if (op.value.amount.nai === '@@000000021') {
            unit = 'HIVE'
          } else if (op.value.amount.nai === '@@000000013') {
            unit = 'HBD'
          }
          op.value.amount = `${Number(op.value.amount.amount) / Math.pow(10, op.value.amount.precision)} ${unit}`;
        }
        return [typeB, op.value]
      })
      tx.transaction_id = block.transaction_ids[index]
      tx.block_num = parseInt(block.block_id.slice(0, 8), 16)
      tx.timestamp = block.timestamp
      return tx;
    })
    return block
  })
  return blocks
}

export async function* liveHiveBlocks(API, opts: {
  start_block: number,
  signal: AbortSignal
}) {


  let last_block = opts.start_block
  let count = 0;
  let bh = 0;
  const headUpdater = setInterval(async () => {
    try {
      const hive = new Client(HIVE_API)
      bh = await hive.blockchain.getCurrentBlockNum()
      // const dynProps = await hive.database.getDynamicGlobalProperties()
      // console.log({
      //   last_irreversible_block_num: dynProps.last_irreversible_block_num,
      //   head_block_number: dynProps.head_block_number
      // })
      // console.log(bh, last_block,)
      count = bh - last_block
      // console.log('count', count)
    } catch {

    }
  }, 3000)

  opts.signal.addEventListener('abort', () => {
    clearInterval(headUpdater)
  })


  for (; ;) {
    if (count < 1 || bh === last_block) {
      await sleep(50)
      continue;
    }

    if (opts.signal.aborted) {
      return []
    }

    if (bh > last_block + 1) {
      try {
        const { data } = await Axios.post(API, {
          "jsonrpc": "2.0",
          "method": "block_api.get_block_range",
          "params": {
            "starting_block_num": last_block,
            "count": count > 100 ? 100 : count
          },
          "id": 1
        })

        for (let block of parseHiveBlocks(data.result.blocks)) {
          // console.log('281', last_block, parseInt(block.block_id.slice(0, 8), 16), bh)
          last_block = parseInt(block.block_id.slice(0, 8), 16)
          count = bh - last_block
          // console.log(new Date().getTime() - new Date(block.timestamp + "Z").getTime())


          // console.log(block.timestamp, new Date().toISOString(), new Date().getTime() - new Date(block.timestamp + "Z").getTime(), new Date().getTime() - requestTime.getTime())
          yield block
        }

      } catch (ex) {
        // console.log(ex)
        await sleep(5_000)
      }
    }
    if (bh === last_block + 1) {
      try {
        const lstBlock = await HiveClient.database.getBlock(bh)
        if (lstBlock) {
          last_block = parseInt(lstBlock.block_id.slice(0, 8), 16)
          // console.log(lstBlock)
          // console.log(new Date().getTime() - new Date(lstBlock.timestamp + "Z").getTime())
          yield lstBlock
        } else {
          await sleep(500)
        }
      } catch (ex) {
        await sleep(5_000)
      }
    }
    await sleep(1)
  }
}

export async function streamHiveBlocks(API, opts) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { data } = await Axios.post(API, {
        "jsonrpc": "2.0",
        "method": "block_api.get_block_range",
        "params": {
          "starting_block_num": opts.start_block,
          "count": opts.count
        },
        "id": 1
      })

      if (!data.result) {
        console.log(data)
      }
      return parseHiveBlocks(data.result.blocks)
    } catch (ex) {
      
      // console.log(ex)
      if (attempt === 0) {
        await sleep(5_000)
      } else {
        await sleep(20_000 * attempt)
      }
      continue;
    }

  }
  throw new Error('Block stream failed after 5 requests')
}

/**
 * New block streaming utiziling batch requests (if available)
 * Improves stability and speed of block streaming
 */
export class fastStreamV2 {
  constructor() {

  }

  private async testAPIs() {
    const API_LIST = [
      'https://techcoderx.com',
      'https://api.openhive.network',
    ]

    const testedAPIs = []
    for (let api of API_LIST) {


    }
  }

  async start() {

  }
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


export const NULL_DID = 'did:key:z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP' // Null address should go to an empty ed25519 key


export async function verifyMultiJWS(dagJws: DagJWS, signer: DID) {
  let auths: string[] = [];

  for (let sig of dagJws.signatures) {
    const obj = {
      signatures: [sig],
      payload: dagJws.payload,
    }
    const { kid } = await signer.verifyJWS(obj)

    auths.push(kid.split('#')[0])
  }

  return {
    payload: dagJws.payload,
    auths
  }
}
export async function verifyMultiDagJWS(dagJws: DagJWS, signer: DID) {
  let auths: string[] = [];

  for (let sig of dagJws.signatures) {
    const obj = {
      link: dagJws.link,
      signatures: [sig],
      payload: dagJws.payload,
    }
    const { kid } = await signer.verifyJWS(obj)

    auths.push(kid.split('#')[0])
  }

  return {
    payload: dagJws.payload,
    link: dagJws.link,
    auths
  }
}



export async function unwrapDagJws(dagJws: any, ipfs: IPFSHTTPClient, signer: DID) {
  const dag = await verifyMultiDagJWS(dagJws, signer)

  return {
    ...dag,
    content: (await ipfs.dag.get((dag as any).link)).value
  }
}

export async function createJwsMultsign(data: any, signers: DID[]) {
  let signatures: JWSSignature[] = []
  let signedDag: DagJWS
  for (let signer of signers) {
    signedDag = await signer.createJWS(data)
    let d = await signer.createDagJWS(data)
    // console.log('signedDag', signedDag, d.jws)
    signatures.push(...signedDag.signatures)
  }

  if (!signers.length) {
    throw new Error('no signers')
  }
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
  return {
    payload: signedDag!.payload,
    signatures,
    // link: signedDag.jws.link,
  }
}

export class Benchmark {
  startTime: Date
  stages: Record<string, {
    name: string,
    value: Date
  }>
  stageNum: number
  constructor() {
    this.startTime = new Date();
    this.stages = {}
    this.stageNum = 1;
  }

  stage(name: string) {
    this.stages[this.stageNum] = {
      value: new Date(),
      name
    }
    this.stageNum = this.stageNum + 1;
  }
}

export class BenchmarkContainer {
  benchmarks: Record<string, Benchmark>
  benchmarkCount: number
  logger: winston.Logger

  constructor() {
    this.benchmarks = {

    }
    this.benchmarkCount = 0;

    this.logger = getLogger({
      prefix: 'benchmark container',
      printMetadata: true,
      level: 'debug',
    })
  }
  table() {
    const table = {}
    const table2 = {}
    for (let bench of Object.values(this.benchmarks)) {
      for (let [key, value] of Object.entries(bench.stages)) {
        if (!table[key]) {
          table[key] = {
            value: 0,
            name: value.name
          }
        }
        table[key].value = (table[key].value) + (value.value.getTime() - bench.startTime.getTime())
        if (!table2[key]) {
          table2[key] = []
        }
        table2[key].push(value.value.getTime() - bench.startTime.getTime())
      }
    }
    for (let [key, value] of Object.entries(table)) {
      table[key] = { value: (value as any).value / this.benchmarkCount, name: (value as any).name }
    }
    this.logger.info('benchmark infos', table)
  }
  createInstance() {
    const bench = new Benchmark();
    this.benchmarkCount = this.benchmarkCount + 1
    this.benchmarks[this.benchmarkCount] = bench
    return bench;
  }
}


export async function getCommitHash() {
  const fsPromise = await import('fs/promises'); //Modular import
  let buf
  try {
    buf = await fsPromise.readFile('./.git/refs/heads/main')
  } catch {
    try {
      buf = await fsPromise.readFile('/root/git_commit')
    } catch {

    }
  }

  return buf.toString();
}

export function calcBlockInterval(options: {
  currentBlock: number,
  intervalLength: number,
  marginLength?: number
}) {

  const { currentBlock, intervalLength } = options;

  const currentMod = currentBlock % intervalLength
  const last = currentBlock - currentMod

  return {
    next: currentBlock + (intervalLength - currentMod),
    last,
    currentMod,
    isActive: currentMod === 0,
    isMarginActive: options.marginLength ? currentMod < options.marginLength : false
  }
}

export function median(arr) {
  const mid = Math.floor(arr.length / 2),
    nums = [...arr].sort((a, b) => a - b);
  return arr.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

export function createIPFSClient(options?: IPFS.Options, pinEverything: boolean = false) {
  const instance = IPFS.create(options);

  // pla: overriding both methods to ensure that at any place those methods are used and the "pinEverything" setting of a node is set
  // the content is pinned and persists locally

  if (pinEverything) {
    const originalDagGet = instance.dag.get;
    instance.dag.get = async (cid: IPFS.CID<unknown, number, number, Version>, options?: any) => {
      try {
        instance.pin.add(cid);
      } catch {
        globalLogger.error(`error pinning ${cid}`)
      }
      const result = await originalDagGet.call(instance.dag, cid, options);
      return result;
    };
  
    const originalCat = instance.cat;
    instance.cat = (ipfsPath: IPFS.CID | string, options?: any) => {
      try {
        instance.pin.add(ipfsPath);
      } catch {
        globalLogger.error(`error pinning ${ipfsPath}`)
      }
      const originalIterable = originalCat.call(instance, ipfsPath, options);
      const modifiedIterable = {
        [Symbol.asyncIterator]: async function* () {
          for await (const chunk of originalIterable) {
            yield chunk;
          }
        },
      };
      return modifiedIterable;
    };
  }

  return instance;
}

  
export class ModuleContainer {
  modules: Array<any>;
  moduleList: Array<string>
  moduleName: string;
  parentRegFunc: Function
  constructor(name) {
    this.moduleName = name;
    // this.moduleName = moduleName
    this.modules = []
    this.moduleList = []
  }

  regNames() {
    for (let [key, regClass] of this.modules) {
      this.moduleList.push(`${regClass.moduleName}`);
      this.moduleList.push(...(regClass?.moduleList || []).map(e => {
        return `${key}.${e}`
      }))
    }
  }

  regModule(name, regClass) {
    regClass.moduleName = `${this.moduleName}.${name}`
    this.modules.push([name, regClass])
  }


  async startModules() {
    let startStack: any[] = []
    for (let [key, regClass] of this.modules) {
      if (regClass.start) {
        try {
          console.log('Starting', regClass.moduleName)
          await regClass.start()
        } catch (ex) {
          startStack.push(key, ex)
        }
      }
    }
    return startStack;
  }

  async stopModules() {
    let stopStack: any[] = []
    for (let [key, regClass] of this.modules) {
      if (regClass.stop) {
        try {
          await regClass.stop()
        } catch (ex) {
          stopStack.push(key, ex)
        }
      }
    }
    return stopStack;
  }
  lsModules(prefix: string, recursive: true) {

    if (recursive) {
      return this.modules.map(([key, e]) => {
        return [[key, e], e.lsModules()]
      });
    } else {
      return this.modules.map(([key, e]) => {

        return [key]
      });
    }
  }
  // if(recursive) {
  //   return this.modules.map(([,e]) => {
  //     let obj
  //     if(e.lsModules) {
  //       console.log('running')
  //       obj = e.lsModules(prefix)
  //     }
  //     console.log('obj is', obj)
  //     return obj
  //   });
  // } else {
  //   return this.modules.map(([,e]) => {
  //     return [`${prefix}.${e.moduleName}`, [], e.lsModules]
  //   });
  // }

  //   const modules = this.modules.map(e => {
  //       if(prefix) {
  //           return [`${prefix}.${e[0]}`, e[1]]
  //       } else {
  //           return [e[0], e[1]];
  //       }
  //   });

  //   if(recursive) {
  //     const mods = modules.map(([key, reg])=> {
  //       let key2 = `${prefix}.${key}`
  //         if(reg.lsModules) {
  //           return [key2, reg.lsModules(key2, true, true)]
  //         } else {
  //           return [key2, []]
  //         }
  //     })
  //     if(inR) {
  //       return modules.map(e => e)
  //     } else {
  //       return modules.map(e => e[0])[0]
  //     }
  //   }
  // if(inR) {
  //   return modules.map(e => e)
  // } else {
  //   return modules.map(e => e[0])
  // }
}

export function isExecutedDirectly(currentFile: string) {
  return currentFile === pathToFileURL(process.argv[1]).href
}

export function createMongoDBClient(dbSuffix?: string) {
  return dbSuffix !== undefined && dbSuffix !== '' ? mongo.db('vsc-' + dbSuffix) : mongo.db('vsc')
}
