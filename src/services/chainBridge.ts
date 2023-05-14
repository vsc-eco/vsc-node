import { CID } from 'multiformats'
import NodeSchedule from 'node-schedule'
import dhive, { PrivateKey } from '@hiveio/dhive'
import { CoreService } from '.'
import { fastStream, HiveClient, unwrapDagJws, verifyMultiDagJWS } from '../utils'
import 'dotenv/config'
import { Collection } from 'mongodb'
import networks from './networks'
import { WitnessService } from './witness'
import type PQueue from 'p-queue'
import { VMScript } from 'vm2'
import * as vm from 'vm';
import Pushable from 'it-pushable'
import { CommitmentStatus, Contract, ContractCommitment } from '../types/contracts'
import EventEmitter from 'events'
import { DagJWS, DagJWSResult, DID } from 'dids'
import { IPFSHTTPClient } from 'ipfs-http-client'
import { BlockRecord, TransactionConfirmed, TransactionDbStatus, TransactionDbType } from '../types'
import { VSCTransactionTypes, ContractInput, ContractOutput } from '../types/vscTransactions'
import { CoreTransactionTypes } from '../types/coreTransactions'

export class ChainBridge {
  self: CoreService
  hiveKey: dhive.PrivateKey
  blockHeaders: Collection
  stateHeaders: Collection
  contracts: Collection
  witness: WitnessService
  witnessDb: Collection
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
    this.self.logger.debug('creating block with following unconfirmed tx', txs)

    if(txs.length === 0) {
      this.self.logger.info('not creating block, no tx found')
      return;
    }

    let state_updates = {}
    let txHashes = []
    let transactions = []
    for (let txContainer of txs) {
      //Verify CID is available
      try {
        const signedTransaction: DagJWS = (await this.self.ipfs.dag.get(CID.parse(txContainer.id))).value
        const { payload, kid } = await this.self.identity.verifyJWS(signedTransaction)
        const [did] = kid.split('#')
        this.self.logger.debug('signed tx', signedTransaction as any)
        const content = (await this.self.ipfs.dag.get((signedTransaction as any).link as CID)).value

        this.self.logger.debug('including tx in block', txContainer, payload)

        if (content.op === VSCTransactionTypes.call_contract) {
          // pla: just pass on the tx
        } else if (content.op === VSCTransactionTypes.contract_output) {
          // pla: combine other executors contract invokation results in multisig and create the contract_output tx
        } else if (content.op === VSCTransactionTypes.update_contract) {

        }

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
      } catch (ex) {
        console.log(ex)
        this.self.logger.error('error while attempting to create block', ex)
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
    const blockHash = await this.self.ipfs.dag.put(block)
    this.self.logger.debug('published block on ipfs', block, blockHash)

    try {
      const result = await HiveClient.broadcast.json(
        {
          required_auths: [],
          required_posting_auths: [process.env.HIVE_ACCOUNT],
          id: 'vsc.announce_block',
          json: JSON.stringify({
            action: CoreTransactionTypes.announce_block,
            block_hash: blockHash.toString(),
            net_id: this.self.config.get('network.id'),
          }),
        },
        this.hiveKey,
      )
      this.self.logger.debug('published block on hive', blockHash)
    } catch (ex) {
      this.self.logger.error('error while publishing block to hive', ex)
    }
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
      try {
        const out = await this.self.ipfs.dag.get(CID.parse(tx.id), {
          timeout: 10 * 1000,
        })
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

  async countHeight(id: string) {
    let block = (await this.self.ipfs.dag.get(CID.parse(id))).value
    let height = 0

    for (;;) {
      if (block.previous) {
        block = (await this.self.ipfs.dag.get(block.previous)).value
        height = height + 1
      } else {
        break
      }
    }

    this.self.logger.debug('counted block height', height)
    return height
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

    if (tx.op === VSCTransactionTypes.call_contract) {
      if (this.self.config.get('witness.enabled')) {

        // pla: the section below doesnt work when no contract can be retrieved from the local ipfs node. 
        // what to do when not beeing able to receive contract object? same for VSCTransactionTypes.contract_output
        let auths = ['NOT FOUND']
        try {
          const transactionRaw: ContractInput = (await this.self.ipfs.dag.get(CID.parse(tx.id))).value
          const {content, auths} = await unwrapDagJws(transactionRaw, this.self.ipfs, this.self.identity)
        } catch (e) {
          this.self.logger.error("not able to receive contract from local ipfs node ", tx.id)
        }

        await this.self.transactionPool.transactionPool.findOneAndUpdate({
          id: tx.id.toString(),
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
      }
    } else if (tx.op === VSCTransactionTypes.contract_output) {
      const transactionRaw: ContractOutput = (await this.self.ipfs.dag.get(CID.parse(tx.id) as any)).value
      const {content, auths} = await unwrapDagJws(transactionRaw, this.self.ipfs, this.self.identity)

      this.self.logger.debug("contract output received", content)

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

      // update parent tx (call contract)
      
      await this.self.transactionPool.transactionPool.findOneAndUpdate({
        id: transactionRaw.parent_tx_id,
      }, {
          $set: {
              status: TransactionDbStatus.confirmed,
              executed_in: blockHash
          }
      });
    }
    else if (tx.op === VSCTransactionTypes.update_contract) {
      // pla: TBD update general stuff in regards to the contract... description etc.
    }
  }

  async processCoreTransaction(tx: any, json: any, txInfo: {
    account: string,
    block_height: string
    timestamp: Date
  }) {
    if(json.net_id !== this.self.config.get('network.id')) {
      this.self.logger.warn('received transaction from a different network id! - will not process')
      return;
    }
    console.log(json)
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
    } else if(json.action === "allow_witness") { 
      const verifyData = await this.self.identity.verifyJWS(json.proof)
      console.log('allow witness', verifyData)
      console.log(tx, verifyData.payload)
      const diff = txInfo.timestamp.getTime() - new Date(verifyData.payload.ts).getTime() 
      console.log('tx diff', diff)
      if(Math.abs(diff) < 30 * 1000) {
        try {
          await this.witnessDb.findOneAndUpdate({
            did: verifyData.payload.node_id
          }, {
            $set: {
              trusted: true
            }
          })
        } catch {

        }
      } else {
        this.self.logger.warn(`received transaction with high lag. Possible replay attack - ${tx.transaction_id}`)
      }
    } else if(json.action === "disallow_witness") {
      const verifyData = await this.self.identity.verifyJWS(json.proof)
      console.log('allow witness', verifyData)
      console.log(tx, verifyData.payload)
      const diff = txInfo.timestamp.getTime() - new Date(verifyData.payload.ts).getTime() 
      console.log('tx diff', diff)
      if(Math.abs(diff) < 30 * 1000) {
        try {
          await this.witnessDb.findOneAndUpdate({
            did: verifyData.payload.node_id
          }, {
            $set: {
              trusted: false
            }
          })
        } catch {
          
        }
      } else {
        this.self.logger.warn(`received transaction with high lag. Possible replay attack - ${tx.transaction_id}`)
      }
    } else if (json.action === 'announce_block') {

      /**
       * TODO: Calculate expected witness account
       */
      const expectedAccount = ""
      if(txInfo.account === expectedAccount) {
        
      }

      const data = await this.self.ipfs.dag.get(CID.parse(json.block_hash))

      // console.log(JSON.stringify(data.value, null, 2))
      for(let tx of data.value.txs) {
        await this.self.transactionPool.transactionPool.findOneAndUpdate({
          id: tx.id.toString()
        }, {
          $set: {
            status: TransactionDbStatus.included
          }
        })
        console.log(tx)
        const txData = (await this.self.ipfs.dag.get(tx.id)).value
        const txData2 = (await this.self.ipfs.dag.get(tx.id, {
          path: 'link'
        })).value
        const verifyData = await this.self.identity.verifyJWS(txData)
        console.log(verifyData, txData, txData2)
      }

      // alp: DEBUG: ASSUME THE WITNESS ACC IS ALREADY CALC'D
      this.events.emit('vsc_block', json)
    } else if (json.action === 'create_contract') {
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
        this.self.logger.error('not able to inject contract into the local database', tx.transaction_id)
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
          this.self.logger.error('not able to inject contract commitment into the local database', tx.transaction_id)
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
        this.self.logger.warn('not able to leave contract commitment', tx.transaction_id)
      }
  } else {
      //Unrecognized transaction
      this.self.logger.warn('not recognized tx type', json.action)
    }
  }
  

  async start() {
    this.stateHeaders = this.self.db.collection('state_headers')
    this.blockHeaders = this.self.db.collection('block_headers')
    this.witnessDb = this.self.db.collection('witnesses')

    this.hiveKey = PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING)

    this.blockQueue = new (await import('p-queue')).default({concurrency: 1})

    this.witness = new WitnessService(this.self)

    this.streamOut = Pushable()

    this.events.on('vsc_block', (block) => {
      this.streamOut.push(block)
    })

    NodeSchedule.scheduleJob('* * * * *', async () => {
      await this.verifyMempool()
    })

    const network_id = this.self.config.get('network.id')

    this.self.logger.debug('current network_id', network_id)
    
    let startBlock =
      (
        (await this.stateHeaders.findOne({
          id: 'hive_head',
        })) || ({} as any)
      ).block_num || 73348150  // pla: useful to set a manual startBlock here for debug purposes
    
    this.self.logger.debug('starting block stream at height', startBlock)
    
    const stream = await fastStream.create({
      //startBlock: networks[network_id].genesisDay,
      startBlock: startBlock,
      trackHead: true
    })

    void (async () => {
      for await(let block of this.streamOut) {
        console.log('vsc block', block)
        
        const blockContent = (await this.self.ipfs.dag.get(CID.parse(block.block_hash))).value
        await this.blockHeaders.insertOne({
          height: await this.countHeight(block.block_hash),
          id: block.block_hash,
        })

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
            if(op_id === "account_update") {
              try {
                const json_metadata = JSON.parse(payload.json_metadata)
                if(json_metadata.vsc_node) {
                  const {payload: proof, kid} = await this.self.identity.verifyJWS(json_metadata.vsc_node.signed_proof)
                  const [did] = kid.split('#')
                  console.log(proof)
                  await this.witnessDb.findOneAndUpdate({
                    did,
                    account: payload.account,
                    peer_id: proof.ipfs_peer_id
                  }, {
                    $set: {
                      signing_keys: proof.witness.signing_keys,
                      last_signed: new Date(proof.ts),
                      net_id: proof.net_id
                    }
                  }, {
                    upsert: true
                  })
                }
              } catch {
                
              }
            }
            if(op_id === "custom_json") {
              if (payload.id === 'vsc-testnet-hive' || payload.id.startsWith('vsc.')) {
                const json = JSON.parse(payload.json)
                await this.processCoreTransaction(tx, json, {
                  account: payload.required_posting_auths[0],
                  block_height,
                  timestamp: new Date(block.timestamp + "Z")
                })
              }
            }
          }
        }

        if (this.self.options.debugHelper.nodePublicAdresses.includes(this.self.config.get('identity.nodePublic'))) { 
          this.self.logger.debug(`current block_head height ${block_height}`)
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
    

    setInterval(() => {
      this.self.logger.info(`current block lag ${stream.blockLag}`)
    }, 60 * 1000)

    let producingBlock = false;
    setInterval(async() => {
      if (this.self.options.debugHelper.nodePublicAdresses.includes(this.self.config.get('identity.nodePublic'))) {
        
        if (stream.blockLag < 5) {
          //Can produce a block
          const offsetBlock = stream.currentBlock - networks[network_id].genesisDay
          if((offsetBlock %  networks[network_id].roundLength) === 0) {
            if(!producingBlock) {
              this.self.logger.info('Can produce block!! at', stream.currentBlock)
              producingBlock = true;
              await this.createBlock()
            }
          } else {
            producingBlock = false;
          }
        }
      }
    }, 300)
  }
}
