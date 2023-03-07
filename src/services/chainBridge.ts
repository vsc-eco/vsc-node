import { TileDocument } from '@ceramicnetwork/stream-tile'
import { CID } from 'multiformats'
import NodeSchedule from 'node-schedule'
import dhive, { PrivateKey } from '@hiveio/dhive'
import { CoreService } from '.'
import { BlockRecord, ContractOutput, TransactionDbStatus, TransactionDbType } from '../types'
import { fastStream, HiveClient, unwrapDagJws, verifyMultiJWS } from '../utils'
import 'dotenv/config'
import { Collection } from 'mongodb'
import networks from './networks'
import { WitnessService } from './witness'
import type PQueue from 'p-queue'
import { VMScript } from 'vm2'
import * as vm from 'vm';
import Pushable from 'it-pushable'
import { CommitmentStatus, Contract, ContractCommitment } from '../types/contracts'
import { ContractInput, TransactionConfirmed, VSCOperations } from '../types'
import { TransactionTypes } from '../types/transactions'
import EventEmitter from 'events'
import { DagJWS, DagJWSResult, DID } from 'dids'
import { IPFSHTTPClient } from 'ipfs-http-client'


console.log(dhive, PrivateKey)





export class ChainBridge {
  self: CoreService
  hiveKey: dhive.PrivateKey
  blockHeaders: Collection
  stateHeaders: Collection
  contracts: Collection
  witness: WitnessService
  witnessDb: any
  events: EventEmitter
  streamOut: Pushable.Pushable<any>

  blockQueue: PQueue
  block_height: number

  constructor(self: CoreService) {
    this.self = self

    this.events = new EventEmitter()
  }

  async createBlock() {
    const txs = await this.self.transactionPool.transactionPool
      .find({
        status: TransactionDbStatus.unconfirmed,
        accessible: true,
      })
      .toArray()
    console.log('here 1', txs)
    if(txs.length === 0) {
      return;
    }
    //console.log(txs)
    let state_updates = {}
    let txHashes = []
    let transactions = []
    for (let txContainer of txs) {
      //Verify CID is available
      try {
        //console.log('1', tx.id)
        const signedTransaction: DagJWS = (await this.self.ipfs.dag.get(CID.parse(txContainer.id))).value
        const { payload, kid } = await this.self.identity.verifyJWS(signedTransaction)
        const [did] = kid.split('#')
        console.log(signedTransaction as any)
        const content = (await this.self.ipfs.dag.get((signedTransaction as any).link as CID)).value

        //console.log('2', tx.id)
        //console.log(payload)

        if (content.op === VSCOperations.call_contract) {
          // pla: just pass on the tx
        } else if (content.op === VSCOperations.contract_output) {
          // pla: combine other executors contract invokation results in multisig and create the contract_output tx
        } else if (content.op === VSCOperations.update_contract) {

        }

        console.log(txContainer)

        txHashes.push({
          op: txContainer.op,
          id: CID.parse(txContainer.id),
          lock_block: txContainer.lock_block,
        })

        transactions.push({
          op: txContainer.op,
          id: CID.parse(txContainer.id),
          type: TransactionDbType.input,
        })

        // pla: is moved to coreTransaction, correct? 
        if (txContainer.op === 'announce_node') {
          const cid = await this.self.ipfs.object.new()
          const txCid = await this.self.ipfs.dag.put(payload.payload)
          let protoBuf = await this.self.ipfs.object.patch.addLink(cid, {
            Name: payload.payload.peer_id,
            Hash: txCid,
          })
          //console.log('protoBuf', protoBuf)
          state_updates['node-info'] = protoBuf
        }
        /**
         * @todo validate updates
         */
        if(txContainer.op === TransactionTypes.create_contract) {
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
      if (tx.type === TransactionDbType.input) {
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

    // await this.blockHeaders.insertOne({
    //   height: await this.countHeight(blockHash.toString()),
    //   id: blockHash.toString(),
    // })

    console.log('rd 11')

    try {
      const result = await HiveClient.broadcast.json(
        {
          required_auths: [],
          required_posting_auths: [process.env.HIVE_ACCOUNT],
          id: 'vsc.announce_block',
          json: JSON.stringify({
            action: TransactionTypes.announce_block,
            block_hash: blockHash.toString(),
            net_id: this.self.config.get('network.id'),
          }),
        },
        this.hiveKey,
      )

      await HiveClient.transaction.findTransaction(result.id)
      // console.log(out)
    } catch (ex) {
      console.log(ex)
    }

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

  async processVSCBlockTransaction(tx: TransactionConfirmed, blockHash: string) {
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

    if (tx.op === VSCOperations.call_contract) {
      // pla: value needs to be taken of global variable
      const isNodeExecuter = true;

      if (isNodeExecuter) {
        // pla: maybe add the contract id to the TransactionRaw to prevent unnecessary fetches

        const transactionRaw: ContractInput = (await this.self.ipfs.dag.get(CID.parse(tx.id))).value
        const {content, auths} = await unwrapDagJws(transactionRaw, this.self.ipfs, this.self.identity)

        await this.self.transactionPool.transactionPool.findOneAndUpdate({
          id: tx.id,
        }, {
          $set: {
            account_auth: auths[0],
            op: tx.op,
            lock_block: null,
            status: TransactionDbStatus.included,
            first_seen: new Date(),
  
            type: TransactionDbType.input,
            included_in: blockHash,

            executed_in: null,
            output: null,
  
            local: false,
            accessible: true
          }
        }, {
          upsert: true
        })

        // if (await this.hasExecuterJoinedContract(content.contract_id)) {

        //   // const results = this.self.contractEngine.contractExecuteRaw(contractInputTx.contract_id, [contractInputTx])
        //   // pla: do the multisig proof and publish it via pubsub
        //   // the selected node is then going to publish the associated VSCOperations.contract_output tx
        // }
      }
    } else if (tx.op === VSCOperations.contract_output) {
      const transactionRaw: ContractInput = (await this.self.ipfs.dag.get(CID.parse(tx.id))).value
      const {content, auths} = await unwrapDagJws(transactionRaw, this.self.ipfs, this.self.identity)


      console.log(content)

      //Do validation of executor pool

      await this.self.transactionPool.transactionPool.findOneAndUpdate({
        id: tx.id,
      }, {
        $set: {
          account_auth: auths[0],
          op: tx.op,
          lock_block: null,
          status: TransactionDbStatus.confirmed,
          first_seen: new Date(),

          type: TransactionDbType.core,
          included_in: blockHash,
          executed_in: blockHash,
          output: null,

          local: false,
          accessible: true
        }
      }, {
        upsert: true
      })
      

      
      await this.self.contractEngine.contractDb.findOneAndUpdate({
        contract_id: content.contract_id
      }, {
        $set: {
          state_merkle: content.state_m
        }
      })

    }
    else if (tx.op === VSCOperations.update_contract) {
      // pla: TBD update general stuff in regards to the contract... description etc.
    }
  }

  async processCoreTransaction(tx: any, json: any, txInfo: {
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

      // alp: DEBUG: ASSUME THE WITNESS ACC IS ALREADY CALC'D
      this.events.emit('vsc_block', json)
    } else if (json.action === 'create_contract') {
      // pla: no checks of code/ manifest to ensure performance
      try {
        await this.self.contractEngine.contractDb.insertOne({
          id: tx.transaction_id,
          manifest_id: json.manifest_id,
          name: json.name,
          code: json.code,
          state_merkle: (await this.self.ipfs.object.new({template: 'unixfs-dir'})).toString(),
          creation_tx: tx.transaction_id,
          created_at: tx.expiration
        } as Contract)
      } catch (err){
        console.error('not able to inject contract into the local database\n id: ' + tx.transaction_id)
      }
    } else if (json.action === 'join_contract') {
      const commitment = await this.self.contractEngine.contractCommitmentDb.findOne({
        contract_id: json.contract_id,
        node_identity: json.node_identity
      })

      if (commitment === null) {
        try {
          await this.self.contractEngine.contractCommitmentDb.insertOne({
            id: tx.transaction_id,
            node_id: json.node_id,
            node_identity: json.node_identity,
            contract_id: json.contract_id,
            creation_tx: tx.transaction_id,
            created_at: tx.expiration,
            status: CommitmentStatus.active,
            latest_state_merkle: null,
            latest_update_date: null,
            last_pinged: null,
            pinged_state_merkle: null
          } as ContractCommitment)
        } catch (err) {
          console.error('not able to inject contract commitment into the local database\nid: ' + tx.transaction_id)
        }
      } else {
        await this.self.contractEngine.contractCommitmentDb.findOneAndUpdate(commitment, {
          $set: {
            status: CommitmentStatus.active
          }
        })
      }
    } else if (json.action === 'leave_contract') {
      const commitment = await this.self.contractEngine.contractCommitmentDb.findOne({
        contract_id: json.contract_id,
        node_identity: json.node_identity
      })

      if (commitment !== null) {
        await this.self.contractEngine.contractCommitmentDb.findOneAndUpdate(commitment, {
          $set: {
            status: CommitmentStatus.inactive
          }
        })
      } else {
        console.info('not able to leave contract commitment\nid: ' + tx.transaction_id)
      }
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

    this.streamOut = Pushable()

    this.events.on('vsc_block', (block) => {
      // console.log('emitting', block_height)
      // console.log(block_height)
      this.streamOut.push(block)
    })
  
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
    
    let startBlock =
      (
        (await this.stateHeaders.findOne({
          id: 'hive_head',
        })) || ({} as any)
      ).block_num || 72283179
    
    // pla: useful to set a manual startBlock here for debug purposes
    const stream = await fastStream.create({
      //startBlock: networks[network_id].genesisDay,
      // startBlock: 72283179,
      startBlock: startBlock,
      trackHead: true
    })

    
    void (async () => {
      for await(let block of stream.streamOut) {
        const blockContent = (await this.self.ipfs.dag.get(CID.parse(block.block_hash))).value

        for(let tx of blockContent.txs) {
          this.processVSCBlockTransaction(tx, block.block_hash);
        }
      }
    })()

    void (async () => {
      for await(let [block_height, block] of stream.streamOut) {
        this.block_height = block_height;
        for(let tx of block.transactions) {
          for(let [op_id, payload] of tx.operations) {
            if(op_id === "custom_json") {
              if (payload.id === 'vsc-testnet-hive' || payload.id.startsWith('vsc.')) {
                const json = JSON.parse(payload.json)
                await this.processCoreTransaction(tx, json, {
                  account: payload.required_posting_auths[0],
                  block_height
                })
              }
            }
          }
        }
        if(this.self.config.get('identity.nodePublic') === "did:key:z6MkqnJ2kvpaJCdVBgXH4jkaf95Yu5iJTnuarHw41wxxL5K5") { 
          console.log('block_head', block_height)
        }
        await this.stateHeaders.findOneAndUpdate(
          {
            id: 'hive_head',
          },
          {
            $set: {
              block_num: block_height,
            },
          },
          {
            upsert: true,
          },
        )
      }
    })()
    stream.startStream()
    

    let producingBlock = false;
    setInterval(async() => {
      if(this.self.config.get('identity.nodePublic') === "did:key:z6MkqnJ2kvpaJCdVBgXH4jkaf95Yu5iJTnuarHw41wxxL5K5") {
        console.log(this.self.config.get("identity.nodePublic"), stream.blockLag)
        if(stream.blockLag < 5) {
          //Can produce a block
          const offsetBlock = stream.currentBlock - networks[network_id].genesisDay
          if((offsetBlock %  networks[network_id].roundLength) === 0) {
            if(!producingBlock) {
              console.log('Can produce block!! at', stream.currentBlock)
              producingBlock = true;
              await this.createBlock()
            }
          } else {
            producingBlock = false;
          }
        }
      }
    }, 300)
    // await this.createBlock()
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
