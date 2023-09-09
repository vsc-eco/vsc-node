
import EventEmitter from 'events'
//import PQueue from 'p-queue'
import { BlockchainMode, BlockchainStreamOptions, Client } from '@hiveio/dhive'
import Pushable from 'it-pushable'
import { DagJWS, DID } from 'dids'
import PQueue from 'p-queue'
import { IPFSHTTPClient } from 'ipfs-http-client'
import winston from 'winston'
import Axios from 'axios'
import { getLogger } from './logger'

const HIVE_API = process.env.HIVE_HOST || 'https://hive-api.3speak.tv'

export const HiveClient = new Client(process.env.HIVE_HOST || ['https://api.deathwing.me', 'https://anyx.io', 'https://api.openhive.network', 'https://rpc.ausbit.dev'])

export const OFFCHAIN_HOST = process.env.OFFCHAIN_HOST || "https://us-01.infra.3speak.tv/v1/graphql"

export class fastStream {

  replayComplete: boolean
  blockMap: Record<string, any>

  eventQueue: NodeJS.Timer
  events: EventEmitter
  streamPaused: boolean
  streamOut: Pushable.Pushable<any>
  currentBlock: number
  parser_height: number
  endSet: number
  setSize: number
  queue: PQueue
  headHeight: number
  headTracker: NodeJS.Timer
  logger: winston.Logger
  finalStream: NodeJS.ReadableStream
  
  constructor(queue: PQueue, streamOpts: {
    startBlock: number,
    endBlock?: number
    trackHead?: boolean
  }) {
    this.queue = queue
    this.events = new EventEmitter()    
    this.streamOut = Pushable()
    this.currentBlock = streamOpts.startBlock || 1
    this.parser_height = streamOpts.startBlock || 0
    this.setSize = 150;
    this.endSet = (streamOpts.endBlock - streamOpts.startBlock) / this.setSize

    this.blockMap = {}

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
      if (this.blockMap[this.parser_height]) {
        const block_height = parseInt(this.blockMap[this.parser_height].block_id.slice(0, 8), 16)
        
        this.parser_height = block_height + 1;
        this.events.emit('block', block_height, this.blockMap[block_height])
        delete this.blockMap[block_height]
      }
      for(let key of Object.keys(this.blockMap)) {
        if(Number(key) < this.parser_height) {
          delete this.blockMap[key]; //Memory safety
        }
      }
    }, 1)
  }
  

  get blockLag() {
    return this.headHeight - this.currentBlock
  }

  async startStream() {
    
    this.headTracker = setInterval(async() => {
      const currentBlock = await HiveClient.blockchain.getCurrentBlock()
      this.headHeight = parseInt(currentBlock.block_id.slice(0, 8), 16)

    }, 3000)

    let activeLength = 0
    let finalBlock;
    for (let x = 0; x <= this.endSet; x++) {
      // console.log('101', x)
      // console.log('this.endSet', this.endSet)
      const blocks = await streamHiveBlocks(HIVE_API, {
        count: this.setSize,
        start_block: this.currentBlock
      })
      console.log('this.currentBlock', this.currentBlock)
      // this.currentBlock = this.currentBlock + this.setSize
      
      for(let block of blocks) {
        // console.log(block)
        const block_height = parseInt(block.block_id.slice(0, 8), 16)
        // console.log(this.parser_height, block_height)
        if (this.parser_height === block_height) {
          this.parser_height = block_height + 1;
          this.currentBlock = block_height;
          this.events.emit('block', block_height, block)
        } else if(block_height > this.parser_height) {
          this.blockMap[block_height] = block
        }
      }
    }
    await this.queue.onIdle();
    this.logger.debug("ITS IDLE", {
      finalBlock
    })
    
    this.finalStream = HiveClient.blockchain.getBlockStream({
        from: this.parser_height,
        mode: BlockchainMode.Latest
    })
    await new Promise((resolve) => {
      this.finalStream
        .on('data', (async function (block) {
          const block_height = parseInt(block.block_id.slice(0, 8), 16)
          if (this.parser_height === block_height) {
            this.parser_height = block_height + 1;
            this.currentBlock = block_height;
            this.events.emit('block', block_height, block)
          } else if(block_height > this.parser_height) {
            this.blockMap[block_height] = block
          }
        }).bind(this))
        .on('error', ((error) => {
          clearInterval(this.eventQueue as any)
          this.streamOut.end(error)
        }).bind(this))
        .on('end', (function () {
          // done
          activeLength = activeLength - 1
          if (activeLength === 0) {
            //events.emit('end')
          }
          this.finalStream.removeAllListeners()
          return resolve(null)
        }).bind(this))
    })
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
    this.streamOut.end()
    this.queue.clear()

    if(this.finalStream) {
      this.finalStream.removeAllListeners()
      this.finalStream.pause()
    }
  }

  async onDone() {
    await this.queue.onIdle();
  }

  static async create(streamOpts: {startBlock: number, endBlock?: number, trackHead?: boolean}) {
    const PQueue = (await import('p-queue')).default
    const queue = new PQueue({ concurrency: 35 })
    if(!streamOpts.endBlock) {
      const currentBlock = await HiveClient.blockchain.getCurrentBlock()
      const block_height = parseInt(currentBlock.block_id.slice(0, 8), 16)
      streamOpts.endBlock = block_height;
    }
    
    return new fastStream(queue, streamOpts)
  }
}

export async function streamHiveBlocks(API, opts) {
  const {data} = await Axios.post(API, {
    "jsonrpc":"2.0", 
    "method":"block_api.get_block_range", 
    "params":{
      "starting_block_num": opts.start_block, 
      "count": opts.count
    }, 
    "id":1
  })

  const blocks = data.result.blocks.map(block => {
    block.transactions = block.transactions.map(tx => {
      tx.operations = tx.operations.map(op => {
        const typeS = op.type.split('_')
        return [typeS.splice(0, typeS.length - 1).join('_'), op.value]
      })
      return tx;
    })
    return block
  })
  return blocks
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
    for(let api of API_LIST) {

      
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
  let auths = []; 

  for(let sig of dagJws.signatures) {
    const obj = {
      signatures: [sig],
      payload: dagJws.payload,
    }
    const {kid} = await signer.verifyJWS(obj)
    
    auths.push(kid.split('#')[0])
  }

  return {
    payload: dagJws.payload,
    auths
  }
}
export async function verifyMultiDagJWS(dagJws: DagJWS, signer: DID) {
  let auths = []; 

  for(let sig of dagJws.signatures) {
    const obj = {
      link: dagJws.link,
      signatures: [sig],
      payload: dagJws.payload,
    }
    const {kid} = await signer.verifyJWS(obj)
    
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
  let signatures = []
  let signedDag
  for (let signer of signers) {
    signedDag = await signer.createJWS(data)
    let d = await signer.createDagJWS(data)
    // console.log('signedDag', signedDag, d.jws)
    signatures.push(...signedDag.signatures)
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
    payload: signedDag.payload,
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
    for(let bench of Object.values(this.benchmarks)) {
      for(let [key, value] of Object.entries(bench.stages)) {
        if(!table[key]) {
          table[key] = {
            value: 0,
            name: value.name
          }
        }
        table[key].value = (table[key].value) + (value.value.getTime() - bench.startTime.getTime())
        if(!table2[key]) {
          table2[key] = []
        }
        table2[key].push(value.value.getTime() - bench.startTime.getTime())
      }
    }
    for(let [key, value] of Object.entries(table)) {
      table[key] = {value: (value as any).value /  this.benchmarkCount, name: (value as any).name}
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

  const {currentBlock, intervalLength} = options;

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