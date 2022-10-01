import { TileDocument } from '@ceramicnetwork/stream-tile'
import { CID } from 'multiformats'
import NodeSchedule from 'node-schedule'
import dhive, { PrivateKey } from '@hiveio/dhive'
import { CoreService } from '.'
import { BlockRecord, TransactionDbStatus, TransactionDbType, TransactionOps } from '../types'
import { fastStream, HiveClient } from '@/utils'
import 'dotenv/config'
import { Collection } from 'mongodb'


console.log(dhive, PrivateKey)

export class ChainBridge {
  self: CoreService
  hiveKey: dhive.PrivateKey
  blockHeaders: Collection
  stateHeaders: Collection

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

          console.log(tx)
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
          console.log(tx)
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

  async start() {
    this.stateHeaders = this.self.db.collection('state_headers')
    this.blockHeaders = this.self.db.collection('block_headers')

    //await this.countHeight('bafyreibopg2xjdj37dcljsdcq5bxrcyxtqdfeufpoiecfy25hir3aorux4')

    this.hiveKey = PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING)

    NodeSchedule.scheduleJob('* * * * *', async () => {
      //console.log('Creating scheduled block')
      //await this.createBlock()
    })

    NodeSchedule.scheduleJob('* * * * *', async () => {
      await this.verifyMempool()
    })

    //await this.createBlock()

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
