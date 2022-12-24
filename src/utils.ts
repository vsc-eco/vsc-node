
import EventEmitter from 'events'
//import PQueue from 'p-queue'
import { BlockchainMode, BlockchainStreamOptions, Client } from '@hiveio/dhive'
import Pushable from 'it-pushable'
import { DagJWS, DID } from 'dids'
import PQueue from 'p-queue'
console.log('pushable', Pushable)

export const HiveClient = new Client(process.env.HIVE_HOST || 'https://api.deathwing.me')

export const OFFCHAIN_HOST = process.env.OFFCHAIN_HOST || "https://us-01.infra.3speak.tv/v1/graphql"

export const CERAMIC_HOST = process.env.CERAMIC_HOST || "https://ceramic.3speak.tv"


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
  
  constructor(queue: PQueue, streamOpts) {
    this.queue = queue
    this.events = new EventEmitter()    
    this.streamOut = Pushable()
    this.currentBlock = streamOpts.startBlock || 1
    this.parser_height = streamOpts.startBlock || 0
    this.setSize = 20;
    this.endSet = (streamOpts.endBlock - streamOpts.startBlock) / this.setSize

    this.blockMap = {}

    
    this.startStream = this.startStream.bind(this)
    this.resumeStream = this.resumeStream.bind(this)
    this.pauseStream = this.pauseStream.bind(this)
    this.onDone = this.onDone.bind(this)

    this.events.on('block', (block_height, block) => {
      // console.log('emitting', block_height)
      // console.log(block_height)
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
  
  async startStream() {
    let activeLength = 0
    let finalBlock;
    for (let x = 1; x <= this.endSet; x++) {
      activeLength = activeLength + 1
      const streamOptsInput:BlockchainStreamOptions = {
        from: this.currentBlock,
        to: this.currentBlock + this.setSize - 1,
        mode: BlockchainMode.Latest
      }
      this.currentBlock = this.currentBlock + this.setSize

      finalBlock = streamOptsInput.to;
      this.queue.add(() => {
        const stream = HiveClient.blockchain.getBlockStream(streamOptsInput)
        return new Promise((resolve) => {
          stream
            .on('data', (async function (block) {
              const block_height = parseInt(block.block_id.slice(0, 8), 16)
              // console.log(this, this.parser_height,  block_height)
              if (this.parser_height === block_height) {
                this.parser_height = block_height + 1;
                this.events.emit('block', block_height, block)
              } else if(block_height > this.parser_height) {
                this.blockMap[block_height] = block
              }
            }).bind(this))
            .on('error', ((error) => {
              clearInterval(this.eventQueue)
              console.log('error is', error)
              this.streamOut.end(error)
            }).bind(this))
            .on('end', (function (e) {
              
              // done
              activeLength = activeLength - 1
              if (activeLength === 0) {
                //events.emit('end')
              }
              ;(stream as any).end();
              stream.removeAllListeners()
              return resolve(null)
            }).bind(this))
        })
      })
      await this.queue.onSizeLessThan(50)
      if(this.streamPaused === true) {
        this.queue.pause()
        await new Promise(async (resolve) => {
          this.events.once("unpause", () => {
            resolve(null)
            this.queue.start()
          })
        })
      }
    }
    await this.queue.onIdle();
    console.log("ITS IDLE", {
      finalBlock
    })
    
    const finalStream = HiveClient.blockchain.getBlockStream({
        from: finalBlock,
        mode: BlockchainMode.Latest
    })
    await new Promise((resolve) => {
      finalStream
        .on('data', (async function (block) {
          const block_height = parseInt(block.block_id.slice(0, 8), 16)
          // console.log('getting', block_height)
          if (this.parser_height === block_height) {
            this.parser_height = block_height + 1;
            this.events.emit('block', block_height, block)
          } else if(block_height > this.parser_height) {
            this.blockMap[block_height] = block
          }
        }).bind(this))
        .on('error', ((error) => {
          clearInterval(this.eventQueue)
          this.streamOut.end(error)
        }).bind(this))
        .on('end', (function () {
          // done
          activeLength = activeLength - 1
          if (activeLength === 0) {
            //events.emit('end')
          }
          finalStream.removeAllListeners()
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

  async onDone() {
    await this.queue.onIdle();
  }

  static async create(streamOpts: {startBlock: number, endBlock?: number}) {
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
  
export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
  

export const NULL_DID = 'did:key:z6MkeTG3bFFSLYVU7VqhgZxqr6YzpaGrQtFMh1uvqGy1vDnP' // Null address should go to an empty ed25519 key


export async function verifyMultiJWS(dagJws: DagJWS, signer: DID) {
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
  constructor() {
    this.benchmarks = {
      
    }
    this.benchmarkCount = 0;
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
      table[key] = {value: value. value /  this.benchmarkCount, name: value.name}
    }
    console.log(table)
  }
  createInstance() {
    const bench = new Benchmark();
    this.benchmarkCount = this.benchmarkCount + 1
    this.benchmarks[this.benchmarkCount] = bench
    return bench;
  } 
}



