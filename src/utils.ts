
import EventEmitter from 'events'
//import PQueue from 'p-queue'
import { BlockchainMode, BlockchainStreamOptions, Client } from '@hiveio/dhive'
import Pushable from 'it-pushable'
import { DagJWS, DID } from 'dids'
console.log('pushable', Pushable)

export const HiveClient = new Client(process.env.HIVE_HOST || 'https://api.deathwing.me')

export const OFFCHAIN_HOST = process.env.OFFCHAIN_HOST || "https://us-01.infra.3speak.tv/v1/graphql"

export const CERAMIC_HOST = process.env.CERAMIC_HOST || "https://ceramic.3speak.tv"

console.log(Pushable)
export async function fastStream(streamOpts: {startBlock: number, endBlock?: number}) {
    const PQueue = (await import('p-queue')).default
    const queue = new PQueue({ concurrency: 15 })
    if(!streamOpts.endBlock) {
        const currentBlock = await HiveClient.blockchain.getCurrentBlock()
        const block_height = parseInt(currentBlock.block_id.slice(0, 8), 16)
        streamOpts.endBlock = block_height;
    }
    let setSize = 20
    //let startBlock = 42837;
    //Use 30874325 in the state store (database) to parse from the beginning of 3speak
    let endSet = (streamOpts.endBlock - streamOpts.startBlock) / setSize
  
    /*const numbSets = endSet % setSize
  
    console.log(numbSets)
    console.log(Math.floor(endSet / setSize))*/
  
  
    let currentBlock = streamOpts.startBlock || 1
    const events = new EventEmitter()
    const streamOut = Pushable<any>({
        objectMode: true
    })
  
    let parser_height = streamOpts.startBlock || 0
  

    const blockMap = {}
    /*events.on('block', (height, block) => {
      
      console.log(Object.keys(blockMap))
      if (blockMap[parser_height]) {
        const block_height = parseInt(blockMap[parser_height].block_id.slice(0, 8), 16)
        console.log(`parser_height is ${parser_height}`)
        parser_height = block_height + 1;
        events.emit('block', block_height, blockMap[block_height])
        delete blockMap[block_height]
      }
    })*/
    let activeLength = 0
  
    const eventQueue = setInterval(() => {
      if (blockMap[parser_height]) {
        const block_height = parseInt(blockMap[parser_height].block_id.slice(0, 8), 16)
        
        parser_height = block_height + 1;
        events.emit('block', block_height, blockMap[block_height])
        delete blockMap[block_height]
      }
      for(let key of Object.keys(blockMap)) {
        if(Number(key) < parser_height) {
          delete blockMap[key]; //Memory safety
        }
      }
    }, 1)
  
    const startStream = async () => {
        let finalBlock;
      for (let x = 1; x <= endSet; x++) {
        activeLength = activeLength + 1
        const streamOptsInput:BlockchainStreamOptions = {
          from: currentBlock,
          to: currentBlock + setSize - 1,
          mode: BlockchainMode.Latest
        }
        currentBlock = currentBlock + setSize

        finalBlock = streamOptsInput.to;
        queue.add(() => {
          const stream = HiveClient.blockchain.getBlockStream(streamOptsInput)
          return new Promise((resolve) => {
            stream
              .on('data', async function (block) {
                const block_height = parseInt(block.block_id.slice(0, 8), 16)
                if (parser_height === block_height) {
                  parser_height = block_height + 1;
                  events.emit('block', block_height, block)
                } else if(block_height > parser_height) {
                  blockMap[block_height] = block
                }
              })
              .on('error', (error) => {
                clearInterval(eventQueue)
                streamOut.end(error)
              })
              .on('end', function () {
                // done
                activeLength = activeLength - 1
                if (activeLength === 0) {
                  //events.emit('end')
                }
                ;(stream as any).end();
                stream.removeAllListeners()
                return resolve(null)
              })
          })
        })
        await queue.onSizeLessThan(1250)
      }
      await queue.onIdle();
      console.log("ITS IDLE")
      const finalStream = HiveClient.blockchain.getBlockStream({
          from: finalBlock,
          mode: BlockchainMode.Latest
      })
      await new Promise((resolve) => {
        finalStream
          .on('data', async function (block) {
            const block_height = parseInt(block.block_id.slice(0, 8), 16)
            if (parser_height === block_height) {
              parser_height = block_height + 1;
              events.emit('block', block_height, block)
            } else if(block_height > parser_height) {
              blockMap[block_height] = block
            }
          })
          .on('error', (error) => {
            clearInterval(eventQueue)
            streamOut.end(error)
          })
          .on('end', function () {
            // done
            activeLength = activeLength - 1
            if (activeLength === 0) {
              //events.emit('end')
            }
            finalStream.removeAllListeners()
            return resolve(null)
          })
      })
    }
  
    const onDone = async () => {
      await queue.onIdle();
    }

    events.on('block', (block_height, block) => {
        streamOut.push([block_height, block])
    })    
  
    return {
      events,
      startStream,
      onDone,
      stream: streamOut
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