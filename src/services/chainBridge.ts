import { TileDocument } from '@ceramicnetwork/stream-tile'
import { CID } from 'multiformats'
import NodeSchedule from 'node-schedule'
import dhive, { PrivateKey } from '@hiveio/dhive'
import { CoreService } from '.'
import { BlockRecord, TransactionDbStatus, TransactionDbType, TransactionOps } from '../types'
import { fastStream, HiveClient } from '../utils'
import 'dotenv/config'
import { Collection } from 'mongodb'
import networks from './networks'
import { WitnessService } from './witness'
import type PQueue from 'p-queue'


console.log(dhive, PrivateKey)

export class ChainBridge {
  self: CoreService
  hiveKey: dhive.PrivateKey
  blockHeaders: Collection
  stateHeaders: Collection
  contracts: Collection
  witness: WitnessService
  witnessDb: any

  blockQueue: PQueue
  block_height: number

  constructor(self: CoreService) {
    this.self = self

    
  }

  async createBlock() {
    const txs = await this.self.transactionPool.transactionPool
      .find({
        status: TransactionDbStatus.unconfirmed,
        accessible: true,
      })
      .toArray()
    console.log('here 1', txs)
    //console.log(txs)
    let state_updates = {}
    let txHashes = []
    let transactions = []
    for (let tx of txs) {
      //Verify CID is available
      try {
        //console.log('1', tx.id)
        const content = await this.self.ipfs.dag.get(CID.parse(tx.id))
        const { payload } = await this.self.identity.verifyJWS(content.value)
        //console.log('2', tx.id)
        //console.log(payload)

        txHashes.push({
          op: tx.op,
          id: CID.parse(tx.id),
          lock_block: tx.lock_block,
        })

        transactions.push({
          op: tx.op,
          id: CID.parse(tx.id),
          t: TransactionDbType.input,
        })

        if (tx.op === 'announce_node') {
          const cid = await this.self.ipfs.object.new()
          const txCid = await this.self.ipfs.dag.put(payload.payload)
          let protoBuf = await this.self.ipfs.object.patch.addLink(cid, {
            Name: payload.payload.peer_id,
            Hash: txCid,
          })
          //console.log('protoBuf', protoBuf)
          state_updates['node-info'] = protoBuf
        }
        if (tx.op === 'create_contract') {
          //console.log(tx, payload)

          const tileDoc = await TileDocument.load(this.self.ceramic, payload.payload.stream_id)
          const { name, code } = tileDoc.content as any
          try {
            await this.self.contractEngine.contractDb.insertOne({
              id: payload.payload.stream_id,
              name,
              code,
            })
          } catch {}
        }
        /**
         * @todo validate updates
         */
        if(tx.op === TransactionOps.updateContract) {
          const tileDoc = await TileDocument.load(this.self.ceramic, payload.payload.stream_id)
          const { name, code, revision } = tileDoc.content as any
          try {
            await this.self.contractEngine.contractDb.findOneAndUpdate({
              id: payload.payload.stream_id,
            }, {
              $set: {
                code,
                name,
                revision: revision || 0
              }
            })
          } catch {}
        }
      } catch (ex) {
        console.log(ex)
      }
    }

    const previousBlock = await this.blockHeaders.findOne(
      {},
      {
        sort: {
          height: -1,
        },
      },
    )

    const previous = previousBlock ? CID.parse(previousBlock.id) : null

    console.log('here 2')
    let block: BlockRecord = {
      __t: 'vsc-block',
      /**
       * State updates
       * Calculated from transactions output(s)
       */
      state_updates,
      txs: transactions,
      previous: previous,
      timestamp: new Date().toISOString(),
    }
    //console.log(block)
    const blockHash = await this.self.ipfs.dag.put(block)
    console.log('block hash', blockHash)

    for (let tx of transactions) {
      console.log('here', tx)
      if (tx.t === TransactionDbType.input) {
        await this.self.transactionPool.transactionPool.findOneAndUpdate(
          {
            id: tx.id.toString(),
          },
          {
            $set: {
              status: TransactionDbStatus.included,
              included_in: blockHash.toString(),
            },
          },
        )
      } else {
        await this.self.transactionPool.transactionPool.findOneAndUpdate(
          {
            id: tx.id.toString(),
          },
          {
            $set: {
              status: TransactionDbStatus.confirmed,
              included_in: blockHash.toString(),
              executed_in: blockHash.toString(),
            },
          },
        )
      }
    }

    await this.blockHeaders.insertOne({
      height: await this.countHeight(blockHash.toString()),
      id: blockHash.toString(),
    })

    console.log('rd 11')

    try {
      const result = await HiveClient.broadcast.json(
        {
          required_auths: [],
          required_posting_auths: [process.env.HIVE_ACCOUNT],
          id: 'vsc.announce_block',
          json: JSON.stringify({
            block_hash: blockHash.toString(),
            net_id: this.self.config.get('network.id'),
          }),
        },
        this.hiveKey,
      )

      const out = await HiveClient.transaction.findTransaction(result.id)
    } catch {}

    //console.log(result)

    //console.log(out)
  }

  /**
   * Verifies content in mempool is accessible
   */
  async verifyMempool() {
    const txs = await this.self.transactionPool.transactionPool
      .find({
        status: TransactionDbStatus.unconfirmed,
      })
      .toArray()
    for (let tx of txs) {
      //console.log(tx)
      try {
        const out = await this.self.ipfs.dag.get(CID.parse(tx.id), {
          timeout: 10 * 1000,
        })
        //console.log(out)
        await this.self.transactionPool.transactionPool.findOneAndUpdate(
          {
            _id: tx._id,
          },
          {
            $set: {
              accessible: true,
            },
          },
        )
      } catch {}
    }
  }

  async verifyBlock() {}

  async countHeight(id: string) {
    let block = (await this.self.ipfs.dag.get(CID.parse(id))).value
    let height = 0

    for (;;) {
      if (block.previous) {
        console.log('block height', height)
        block = (await this.self.ipfs.dag.get(block.previous)).value
        height = height + 1
      } else {
        break
      }
    }

    console.log('block height', height)
    return height
  }

  async *transactionStream() {


  }

  async processBlock(block_hash: string) {
    await this.self.ipfs.dag.get(block_hash)
  }


  async processTransaction(tx: any, json: any, txInfo: {
    account: string,
    block_height: string
  }) {
    if(json.net_id !== this.self.config.get('network.id')) {
      return;
    }
    if(json.action === "enable_witness") {
      await this.witnessDb.findOneAndUpdate({
        name: txInfo.account
      }, {
        $set: {
          did: json.did,
          node_id: json.node_id,
          active: true
        }
      }, {
        upsert: true
      })
    } else if (json.action === 'disable_witness') {
      await this.witnessDb.findOneAndUpdate({
        name: txInfo.account
      }, {
        $set: {
          active: false
        }
      }, {
        upsert: true
      })
    } else if (json.action === 'announce_block') {

      /**
       * TODO: Calculate expected witness account
       */
      const expectedAccount = ""
      if(txInfo.account === expectedAccount) {

      }
    } else if (json.action === 'create_contract') {
      try {


        await this.self.contractEngine.contractDb.insertOne({
          id: payload.payload.stream_id,
          name,
          code,
        })
      } catch {}
    } else {
      //Unrecognized transaction
    }
  }
  

  async start() {
    this.stateHeaders = this.self.db.collection('state_headers')
    this.blockHeaders = this.self.db.collection('block_headers')
    this.witnessDb = this.self.db.collection('witnesses')

    //await this.countHeight('bafyreibopg2xjdj37dcljsdcq5bxrcyxtqdfeufpoiecfy25hir3aorux4')

    this.hiveKey = PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING)

    this.blockQueue = new (await import('p-queue')).default({concurrency: 1})

    this.witness = new WitnessService(this.self)

    NodeSchedule.scheduleJob('* * * * *', async () => {
      //console.log('Creating scheduled block')
      //await this.createBlock()
    })

    NodeSchedule.scheduleJob('* * * * *', async () => {
      await this.verifyMempool()
    })

    const network_id = this.self.config.get('network.id')

    console.log('network_id', network_id)
    this.witness.enableWitness()
    
    const stream = await fastStream.create({
      startBlock: networks[network_id].genesisDay,
      trackHead: true
    })
    

    void (async () => {
      for await(let [block_height, block] of stream.streamOut) {
        this.block_height = block_height;
        for(let tx of block.transactions) {
          for(let [op_id, payload] of tx.operations) {
            if(op_id === "custom_json") {
              if (payload.id === 'vsc-testnet-hive' || payload.id.startsWith('vsc.')) {
                const json = JSON.parse(payload.json)
                await this.processTransaction(tx, json, {
                  account: payload.required_posting_auths[0],
                  block_height
                })
              }
            }
          }
        }
      }
    })()
    stream.startStream()
    

    let producingBlock = false;
    setInterval(async() => {
      if(this.self.config.get('identity.nodePublic') === "did:key:z6MkqnJ2kvpaJCdVBgXH4jkaf95Yu5iJTnuarHw41wxxL5K5") {
        console.log(this.self.config.get("identity.nodePublic"), stream.blockLag)
        if(stream.blockLag < 4) {
          //Can produce a block
          const offsetBlock = stream.currentBlock - networks[network_id].genesisDay
          if((offsetBlock %  networks[network_id].roundLength) === 0) {
            if(!producingBlock) {
              console.log('Can produce block!! at', stream.currentBlock)
              producingBlock = true;
              //await this.createBlock()
            }
          } else {
            producingBlock = false;
          }
        }
      }
    }, 300)
    // await this.createBlock()

    /*let startBlock =
      (
        (await this.stateHeaders.findOne({
          id: 'hive_head',
        })) || ({} as any)
      ).block_num || 65787456
    const stream = await fastStream({
      startBlock,
    })

    stream.startStream()

    void (async () => {
      for await (let [block_num, block] of (await stream).stream) {
        await this.stateHeaders.findOneAndUpdate(
          {
            id: 'hive_head',
          },
          {
            $set: {
              block_num,
            },
          },
          {
            upsert: true,
          },
        )
        for (let trx of block.transactions) {
          for (let op of trx.operations) {
            const [op_id, payload] = op
            if (op_id === 'custom_json') {
              if (payload.id === 'vsc.announce_block') {
                console.log('received a block', payload)
              }
            }
          }
        }
      }
    })()*/
  }
}
