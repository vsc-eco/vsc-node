import { CID } from 'multiformats'
import NodeSchedule from 'node-schedule'
import dhive, { PrivateKey } from '@hiveio/dhive'
import { CoreService } from '.'
import { fastStream, HiveClient, unwrapDagJws } from '../utils'
import 'dotenv/config'
import { Collection } from 'mongodb'
import networks from './networks'
import { WitnessService } from './witness'
import type PQueue from 'p-queue'
import * as vm from 'vm';
import Pushable from 'it-pushable'
import { CommitmentStatus, Contract, ContractCommitment } from '../types/contracts'
import EventEmitter from 'events'
import { DagJWS, DagJWSResult, DID } from 'dids'
import { BalanceController, BlockHeader, BlockRecord, BlockRef, Deposit, DepositDrain, DidAuth, DidAuthRecord, TimeLock, TransactionConfirmed, TransactionDbStatus, TransactionDbType, WithdrawLock } from '../types'
import { VSCTransactionTypes, ContractInput, ContractOutput } from '../types/vscTransactions'
import { CoreTransactionTypes } from '../types/coreTransactions'
import moment from 'moment'
import { PayloadTooLargeException } from '@nestjs/common'
import { loggers } from 'winston'
import { YogaServer } from 'graphql-yoga'
import { WithdrawFinalization } from '../types/coreTransactions'
import telemetry from '../telemetry'


export class ChainBridge {
  self: CoreService
  hiveKey: dhive.PrivateKey
  blockHeaders: Collection<BlockHeader>
  stateHeaders: Collection
  contracts: Collection
  witness: WitnessService
  witnessDb: Collection
  balanceDb: Collection<Deposit>
  didAuths: Collection<DidAuthRecord>
  events: EventEmitter
  streamOut: Pushable.Pushable<any>
  multiSigWithdrawBuffer: Array<Deposit>

  blockQueue: PQueue
  block_height: number
  syncedAt: Date | null
  ipfsQueue: PQueue
  hiveStream: fastStream

  constructor(self: CoreService) {
    this.self = self

    this.events = new EventEmitter()

    this.syncedAt = null
  }

  async createBlock() {
    // const txs = await this.self.transactionPool.transactionPool
    //   .find({
    //     status: TransactionDbStatus.unconfirmed,
    //     accessible: true,
    //   })
    //   .toArray()
    // this.self.logger.debug('creating block with following unconfirmed tx', txs)

    // if (txs.length === 0) {
    //   this.self.logger.info('not creating block, no tx found')
    //   return;
    // }

    // let state_updates = {}
    // // let txHashes = []
    // let transactions = []
    // for (let txContainer of txs) {
    //   //Verify CID is available
    //   try {
    //     const signedTransaction: DagJWS = (await this.self.ipfs.dag.get(CID.parse(txContainer.id))).value
    //     const { payload, kid } = await this.self.identity.verifyJWS(signedTransaction)
    //     const [did] = kid.split('#')
    //     const content = (await this.self.ipfs.dag.get((signedTransaction as any).link as CID)).value

    //     this.self.logger.debug('signed tx', signedTransaction as any)
    //     this.self.logger.debug('including tx in block', txContainer, payload)

    //     if (content.op === VSCTransactionTypes.call_contract) {
    //       // pla: just pass on the tx
    //     } else if (content.op === VSCTransactionTypes.contract_output) {
    //       // pla: combine other executors contract invokation results in multisig and create the contract_output tx
    //     } else if (content.op === VSCTransactionTypes.update_contract) {

    //     }

    //     // txHashes.push({
    //     //   op: txContainer.op,
    //     //   id: CID.parse(txContainer.id),
    //     //   lock_block: txContainer.lock_block,
    //     // })

    //     transactions.push({
    //       op: txContainer.op,
    //       id: CID.parse(txContainer.id),
    //       type: TransactionDbType.input,
    //     })
    //   } catch (ex) {
    //     console.log(ex)
    //     this.self.logger.error('error while attempting to create block', ex)
    //   }
    // }

    // const previousBlock = await this.blockHeaders.findOne(
    //   {},
    //   {
    //     sort: {
    //       height: -1,
    //     },
    //   },
    // )

    // const previous = previousBlock ? CID.parse(previousBlock.id) : null

    // let block: BlockRecord = {
    //   __t: 'vsc-block',
    //   __v: '0.1',
    //   /**
    //    * State updates
    //    * Calculated from transactions output(s)
    //    */
    //   state_updates,
    //   txs: transactions,
    //   previous: previous,
    //   timestamp: new Date().toISOString(),
    // }
    // const blockHash = await this.self.ipfs.dag.put(block)
    // this.self.logger.debug('published block on ipfs', block, blockHash)

    // try {
    //   const result = await HiveClient.broadcast.json(
    //     {
    //       required_auths: [],
    //       required_posting_auths: [process.env.HIVE_ACCOUNT],
    //       id: 'vsc.announce_block',
    //       json: JSON.stringify({
    //         action: CoreTransactionTypes.announce_block,
    //         block_hash: blockHash.toString(),
    //         net_id: this.self.config.get('network.id'),
    //       }),
    //     },
    //     this.hiveKey,
    //   )
    //   this.self.logger.debug('published block on hive', blockHash)
    // } catch (ex) {
    //   this.self.logger.error('error while publishing block to hive', ex)
    // }
  }

  /**
   * Verifies content in mempool is accessible
   */
  async verifyMempool() {
    // const txs = await this.self.transactionPool.transactionPool
    //   .find({
    //     status: TransactionDbStatus.unconfirmed,
    //   })
    //   .toArray()
    // for (let tx of txs) {
    //   try {
    //     const out = await this.self.ipfs.dag.get(CID.parse(tx.id), {
    //       timeout: 10 * 1000,
    //     })
    //     await this.self.transactionPool.transactionPool.findOneAndUpdate(
    //       {
    //         _id: tx._id,
    //       },
    //       {
    //         $set: {
    //           accessible: true,
    //         },
    //       },
    //     )
    //   } catch { }
    // }
  }

  async countHeight(id: string) {
    let block = (await this.self.ipfs.dag.get(CID.parse(id))).value
    let height = 0

    for (; ;) {
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
    // await this.self.transactionPool.transactionPool.findOneAndUpdate(
    //   {
    //     id: tx.id.toString(),
    //   },
    //   {
    //     $set: {
    //       status: TransactionDbStatus.included,
    //       included_in: blockHash.toString(),
    //     },
    //   },
    // )

    // if (tx.op === VSCTransactionTypes.call_contract) {
    //   // if (this.self.config.get('witness.enabled')) {

    //   // pla: the section below doesnt work when no contract can be retrieved from the local ipfs node. 
    //   // what to do when not beeing able to receive contract object? same for VSCTransactionTypes.contract_output
    //   let auths = []
    //   try {
    //     console.log('parsing tx', tx)
    //     const transactionRaw: ContractInput = (await this.self.ipfs.dag.get(tx.id as any)).value
    //     const { content, auths: authsOut } = await unwrapDagJws(transactionRaw, this.self.ipfs, this.self.identity)
    //     auths = authsOut;
    //     console.log('tx content', content)
    //     const alreadyExistingTx = await this.self.transactionPool.transactionPool.findOne({
    //       id: tx.id.toString()
    //     })

    //     let local;
    //     if (alreadyExistingTx) {
    //       local = alreadyExistingTx.local
    //     } else {
    //       local = false;
    //     }

    //     await this.self.transactionPool.transactionPool.findOneAndUpdate({
    //       id: tx.id.toString(),
    //     }, {
    //       $set: {
    //         account_auth: auths[0],
    //         op: tx.op,
    //         lock_block: null,
    //         status: TransactionDbStatus.included,
    //         first_seen: new Date(),

    //         type: TransactionDbType.input,
    //         included_in: blockHash,

    //         executed_in: null,
    //         output: null,

    //         local,
    //         accessible: true,
    //         headers: {
    //           contract_id: content.tx.contract_id
    //         }
    //       }
    //     }, {
    //       upsert: true
    //     })
    //   } catch (e) {
    //     console.log(e)
    //     this.self.logger.error("not able to receive contract from local ipfs node ", tx.id)
    //   }

    //   // }
    // } else if (tx.op === VSCTransactionTypes.contract_output) {
    //   const transactionRaw: ContractOutput = (await this.self.ipfs.dag.get(tx.id as any)).value
    //   const { content, auths } = await unwrapDagJws(transactionRaw, this.self.ipfs, this.self.identity)

    //   this.self.logger.debug("contract output received", content)

    //   //Do validation of executor pool

    //   await this.self.transactionPool.transactionPool.findOneAndUpdate({
    //     id: tx.id.toString(),
    //   }, {
    //     $set: {
    //       account_auth: auths[0],
    //       op: tx.op,
    //       lock_block: null,
    //       status: TransactionDbStatus.confirmed,
    //       first_seen: new Date(),

    //       type: TransactionDbType.core,
    //       included_in: blockHash,
    //       executed_in: blockHash,
    //       output: null,

    //       local: false,
    //       accessible: true,
    //       output_actions: content.tx.chain_actions
    //     }
    //   }, {
    //     upsert: true
    //   })

    //   const contractInfo = await this.self.contractEngine.contractDb.findOne({
    //     id: content.tx.contract_id
    //   })
    //   this.self.ipfs.pin.add(CID.parse(content.tx.state_merkle)).catch(e => console.log(e))
      
    //   if(contractInfo) {
    //     this.self.ipfs.pin.rm(CID.parse(contractInfo.state_merkle)).catch(e => console.log(e))
    //   }

    //   await this.self.contractEngine.contractDb.findOneAndUpdate({
    //     id: content.tx.contract_id
    //   }, {
    //     $set: {
    //       state_merkle: content.tx.state_merkle
    //     }
    //   })

    //   // update parent tx (call contract)

    //   await this.self.transactionPool.transactionPool.findOneAndUpdate({
    //     id: content.tx.parent_tx_id,
    //   }, {
    //     $set: {
    //       status: TransactionDbStatus.confirmed,
    //       executed_in: blockHash
    //     }
    //   });
    // }
    // else if (tx.op === VSCTransactionTypes.update_contract) {
    //   // pla: TBD update general stuff in regards to the contract... description etc.
    // }
    // else if (tx.op === VSCTransactionTypes.transferFunds) {
    //   // in here update the balance sheet of a contract, do the calculation on top of the local state, then check the supplied hash if they are equal
    // }
  }

  // pla: the multisig consensus has been reached and a selected node now transfers the funds
  // move to transactionpoolservice?
  async finalizeBalanceUpdate(depositId: string) {
    const memo: WithdrawFinalization = {
      net_id: this.self.config.get('network.id'), 
      deposit_id: depositId,
      action: CoreTransactionTypes.withdraw_finalization
    } as WithdrawFinalization

    //TransactionPoolService.createCoreTransferTransaction... (amount = depositId.active_balance)
  }

  async processCoreTransaction(tx: any, json: any, txInfo: {
    account: string,
    block_height: string,
    timestamp: Date,
    amount?: string,
    to?: string
    memo?: string
  }) {
    // if (json.net_id !== this.self.config.get('network.id')) {
    //   this.self.logger.warn('received transaction from a different network id! - will not process')
    //   return;
    // }
    // console.log(json)
    // if (json.action === CoreTransactionTypes.enable_witness) {
    //   await this.witnessDb.findOneAndUpdate({
    //     name: txInfo.account
    //   }, {
    //     $set: {
    //       did: json.did,
    //       node_id: json.node_id,
    //       active: true
    //     }
    //   }, {
    //     upsert: true
    //   })
    // } else if (json.action === CoreTransactionTypes.disable_witness) {
    //   await this.witnessDb.findOneAndUpdate({
    //     name: txInfo.account
    //   }, {
    //     $set: {
    //       active: false
    //     }
    //   }, {
    //     upsert: true
    //   })
    // } else if (json.action === CoreTransactionTypes.allow_witness) {
    //   const verifyData = await this.self.identity.verifyJWS(json.proof)
    //   console.log('allow witness', verifyData)
    //   console.log(tx, verifyData.payload)
    //   const diff = txInfo.timestamp.getTime() - new Date(verifyData.payload.ts).getTime()
    //   console.log('tx diff', diff)
    //   if (Math.abs(diff) < 30 * 1000) {
    //     try {
    //       await this.witnessDb.findOneAndUpdate({
    //         did: verifyData.payload.node_id
    //       }, {
    //         $set: {
    //           trusted: true
    //         }
    //       })
    //     } catch {

    //     }
    //   } else {
    //     this.self.logger.warn(`received transaction with high lag. Possible replay attack - ${tx.transaction_id}`)
    //   }
    // } else if (json.action === CoreTransactionTypes.dissallow_witness) {
    //   const verifyData = await this.self.identity.verifyJWS(json.proof)
    //   console.log('allow witness', verifyData)
    //   console.log(tx, verifyData.payload)
    //   const diff = txInfo.timestamp.getTime() - new Date(verifyData.payload.ts).getTime()
    //   console.log('tx diff', diff)
    //   if (Math.abs(diff) < 30 * 1000) {
    //     try {
    //       await this.witnessDb.findOneAndUpdate({
    //         did: verifyData.payload.node_id
    //       }, {
    //         $set: {
    //           trusted: false
    //         }
    //       })
    //     } catch {

    //     }
    //   } else {
    //     this.self.logger.warn(`received transaction with high lag. Possible replay attack - ${tx.transaction_id}`)
    //   }
    // } else if (json.action === CoreTransactionTypes.announce_block) {

    //   /**
    //    * TODO: Calculate expected witness account
    //    */
    //   const expectedAccount = ""
    //   if (txInfo.account === expectedAccount) {

    //   }

    //   const data = await this.self.ipfs.dag.get(CID.parse(json.block_hash))

    //   // console.log(JSON.stringify(data.value, null, 2))
    //   for (let tx of data.value.txs) {
    //     // await this.self.transactionPool.transactionPool.findOneAndUpdate({
    //     //   id: tx.id.toString()
    //     // }, {
    //     //   $set: {
    //     //     status: TransactionDbStatus.included
    //     //   }
    //     // })
    //     console.log(tx)
    //     const txData = (await this.self.ipfs.dag.get(tx.id)).value
    //     const txData2 = (await this.self.ipfs.dag.get(tx.id, {
    //       path: 'link'
    //     })).value
    //     const verifyData = await this.self.identity.verifyJWS(txData)
    //     console.log(verifyData, txData, txData2)
    //   }

    //   // TODO, determine if the received block was proposed by the correct witness
    //   this.events.emit('vsc_block', {
    //     ...json,
    //     ...txInfo,
    //     tx
    //   })
    // } else if (json.action === CoreTransactionTypes.create_contract) {
    //   try {
    //     // await this.self.contractEngine.contractDb.insertOne({
    //     //   id: tx.transaction_id,
    //     //   manifest_id: json.manifest_id,
    //     //   name: json.name,
    //     //   code: json.code,
    //     //   state_merkle: (await this.self.ipfs.object.new({ template: 'unixfs-dir' })).toString(),
    //     //   creation_tx: tx.transaction_id,
    //     //   created_at: tx.expiration
    //     // } as Contract)
    //   } catch (err) {
    //     this.self.logger.error('not able to inject contract into the local database', tx.transaction_id)
    //   }

    //   // pla: pin contract code on enabled nodes, note: every dag.get/ cat is a pin via an overridden base function
    //   if (this.self.config.get('ipfs.pinEverything')) {
    //     this.self.ipfs.pin.add(json.code)
    //   }
    // } else if (json.action === CoreTransactionTypes.join_contract) {
    //   const commitment = await this.self.contractEngine.contractCommitmentDb.findOne({
    //     contract_id: json.contract_id,
    //     node_identity: json.node_identity
    //   })

    //   if (commitment === null) {
    //     try {
    //       await this.self.contractEngine.contractCommitmentDb.insertOne({
    //         id: tx.transaction_id,
    //         node_id: json.node_id,
    //         node_identity: json.node_identity,
    //         contract_id: json.contract_id,
    //         creation_tx: tx.transaction_id,
    //         created_at: tx.expiration,
    //         status: CommitmentStatus.active,
    //         latest_state_merkle: null,
    //         latest_update_date: null,
    //         last_pinged: null,
    //         pinged_state_merkle: null
    //       } as ContractCommitment)
    //     } catch (err) {
    //       this.self.logger.error('not able to inject contract commitment into the local database', tx.transaction_id)
    //     }
    //   } else {
    //     await this.self.contractEngine.contractCommitmentDb.findOneAndUpdate(commitment, {
    //       $set: {
    //         status: CommitmentStatus.active
    //       }
    //     })
    //   }
    // } else if (json.action === CoreTransactionTypes.leave_contract) {
    //   const commitment = await this.self.contractEngine.contractCommitmentDb.findOne({
    //     contract_id: json.contract_id,
    //     node_identity: json.node_identity
    //   })

    //   if (commitment !== null) {
    //     await this.self.contractEngine.contractCommitmentDb.findOneAndUpdate(commitment, {
    //       $set: {
    //         status: CommitmentStatus.inactive
    //       }
    //     })
    //   } else {
    //     this.self.logger.warn('not able to leave contract commitment', tx.transaction_id)
    //   }
    // } else if (json.action === CoreTransactionTypes.deposit) {
    //   if (txInfo.to === networks[this.self.config.get('network.id')].multisigAccount) {   
    //     const balanceController = { type: 'HIVE', authority: json.to ?? txInfo.account, conditions: []} as BalanceController

    //     const transferedCurrency = TransactionPoolService.parseFormattedAmount(txInfo.amount);

    //     const deposit = {
    //       from: txInfo.account,
    //       id: tx.transaction_id,
    //       orig_balance: transferedCurrency.amount,
    //       active_balance: transferedCurrency.amount,
    //       created_at: tx.expiration,
    //       last_interacted_at: tx.expiration,
    //       outputs: [],
    //       inputs: [],
    //       asset_type: transferedCurrency.assetSymbol,
    //       create_block: {
    //         block_ref: '', // txInfo.block_ref TODO, block ref still needs to be passed down to processCoreTransaction -> txInfo 
    //         included_block: +txInfo.block_height
    //       } as BlockRef,
    //       controllers: [balanceController],
    //     } as Deposit

    //     if (json.contract_id) {
    //       deposit.contract_id = json.contract_id ?? null // limits the deposit on a specific contract
    //     }

    //     await this.balanceDb.insertOne(deposit);        
    //   }
    //   else {
    //     this.self.logger.warn(`received deposit (${json.action}), but the target account is not the multisig acc`, tx.transaction_id)
    //   }
    // } else if (json.action === CoreTransactionTypes.withdraw_request) {
    //   let deposits = await this.getUserControlledBalances(txInfo.account);

    //   const currentBlock = {
    //     block_ref: '', // txInfo.block_ref TODO, block ref still needs to be passed down to processCoreTransaction -> txInfo 
    //     included_block: +txInfo.block_height
    //   } as BlockRef

    //   deposits = this.getDepositsWithMetConditions(deposits, currentBlock);

    //   const determinedDepositDrains = this.determineDepositDrains(deposits, json.amount);

    //   if (!determinedDepositDrains.isEnoughBalance) {
    //     this.self.logger.warn('withdraw request failed, not sufficient funds available, will not add to database', json)
    //   } else {
    //     const WITHDRAW_FAILED_BLOCK_DISTANCE = 200; // pla: this setting determines within how many blocks the withdraw should be executed by the multisig allowed nodes, if they fail to do so the withdraw is unlocked again and the balance will be treated like a deposit again
    //     const userBalanceController = { 
    //       type: 'HIVE', 
    //       authority: json.to ?? txInfo.account, 
    //       conditions: [
    //         {
    //           type: 'TIME',
    //           lock_applied: currentBlock,
    //           expiration_block: currentBlock.included_block + WITHDRAW_FAILED_BLOCK_DISTANCE
    //         } as TimeLock
    //       ]
    //     } as BalanceController

    //     const multisigBalanceController = { 
    //       type: 'HIVE', 
    //       authority: networks[this.self.config.get('network.id')].multisigAccount, 
    //       conditions: [
    //         {
    //           type: 'WITHDRAW',
    //           expiration_block: currentBlock.included_block + WITHDRAW_FAILED_BLOCK_DISTANCE // here the failed block distance is the other way around, the multisig only has the time window from the withdraw request until the WITHDRAW_FAILED_BLOCK_DISTANCE to execute the withdraw
    //         } as WithdrawLock
    //       ]
    //     } as BalanceController

    //     const deposit = {
    //       from: txInfo.account,
    //       id: tx.transaction_id,
    //       orig_balance: json.amount,
    //       active_balance: json.amount,
    //       created_at: tx.expiration,
    //       last_interacted_at: tx.expiration,
    //       outputs: [],
    //       inputs: [...determinedDepositDrains.deposits],
    //       asset_type: 'HIVE', // TODO, update so its recognized what type of asset has requested for withdraw
    //       create_block: currentBlock,
    //       controllers: [userBalanceController, multisigBalanceController],
    //     } as Deposit

    //     await this.balanceDb.insertOne(deposit); 
        
    //     await this.updateSourceDeposits(determinedDepositDrains.deposits, tx.transaction_id);

    //     // pla: TODO STORE in a database so the tasks for the multisig allowed nodes are not lost on restart
    //     this.multiSigWithdrawBuffer.push(deposit);
    //   }
    // } else if (json.action === CoreTransactionTypes.withdraw_finalization) {
    //   if (tx.from === networks[this.self.config.get('network.id')].multisigAccount) {
    //     const transferedCurrency = TransactionPoolService.parseFormattedAmount(txInfo.amount);

    //     const deposit = await this.balanceDb.findOne({ id: json.deposit_id })

    //     if (deposit.active_balance === transferedCurrency.amount) {
    //       await this.balanceDb.updateOne({ id: json.deposit_id }, 
    //         { 
    //           $set: {
    //             active_balance: 0
    //           }
    //         }
    //       )
    //     } else {
    //       // pla: something went really wrong here, if this is the case, def. investigate
    //       this.self.logger.warn(`received withdraw finalization, but the balance is not the same as the withdraw request, will not update the balance`, tx.transaction_id)
    //     }
    //   } else {
    //     this.self.logger.warn(`received withdraw finalization from non multisig account, disregarding`, tx.transaction_id)
    //   }
    // } else {
    //   //Unrecognized transaction
    //   this.self.logger.warn('not recognized tx type', json.action)
    // }
  }

  // used when a withdraw/ transfer has taken place and the outputs of the deposits are updated with their reference deposits that received the balance
  async updateSourceDeposits(depositDrains: Array<DepositDrain>, targetDepositId: string) {
    for (let depositDrain of depositDrains) {
      const outputDepositDrain = {
        deposit_id: targetDepositId,
        amount: depositDrain.amount
      } as DepositDrain

      await this.balanceDb.updateOne({ id: depositDrain.deposit_id }, 
        { 
          $inc: {
            active_balance: depositDrain.amount * -1
          },
          $push: { 
            outputs: outputDepositDrain
          },
          $set: {
            last_interacted_at: new Date()
          }
        }
      )
    }
  }

  determineDepositDrains(deposits: Array<Deposit>, amount: number): { isEnoughBalance: boolean, deposits: Array<DepositDrain> } {
    let missingAmount = amount;
    const choosenDeposits = [];

    for (let deposit of deposits) {
      if (deposit.active_balance !== 0) {
        let drainedBalance: number;
        if (missingAmount > deposit.active_balance) {
          drainedBalance = deposit.active_balance;
        } else {
          drainedBalance = missingAmount; 
        }
        missingAmount -= drainedBalance;
        choosenDeposits.push({ deposit_id: deposit.id, amount: drainedBalance });        
        
        if (missingAmount == 0) {
          break;
        }
      }
    }

    // pla: TODO probably still has rounding issues
    return { isEnoughBalance: missingAmount === 0, deposits: choosenDeposits };
  }

  // pla: in here verify the controller conditions, if not met the deposit cannot be drained at this point
  getDepositsWithMetConditions(deposits: Array<Deposit>, currentBlock: BlockRef, hashSolvers?: Array<string>): Array<Deposit> {
    // ... if found condition hashlock ... verify if supplied secret is correct
    // ... if found timelock, verify against current block
    
    // return deposits here but sort by active_balance
    return deposits.sort((a, b) => {
      if (a.active_balance < b.active_balance) {
          return -1;
      }
      if (a.active_balance > b.active_balance) {
          return 1;
      }
      return 0;
    });
  }

  // pla: TODO, filter for the asset type, a user might only withdraw/ transfer a specific asset in one tx
  async getUserControlledBalances(accountId: string, contractId?: string): Promise<Array<Deposit>> {
    
    const userOwnedBalancesQuery = {
      'controllers': {
          $elemMatch: {
              'type': { $in: ['HIVE', 'DID'] }, // maybe its needed to convert the hive account into did as well as the deposit from the user might not be his hive acc id, so some deposits would slip through
              'authority': accountId
          }
      }
    };

    if (contractId) {
      userOwnedBalancesQuery['controllers']['$elemMatch']['contract_id'] = contractId;
    }

    return await this.balanceDb.find(userOwnedBalancesQuery).toArray();
  }
  
  // get the users total balance for general deposits or for a specific contract
  async calculateBalanceSum(accountId: string, currentBlock: BlockRef, contractId?: string, hashSolvers?: Array<string>) {
    let balance = 0

    let deposits = await this.getUserControlledBalances(accountId, contractId); 

    deposits = this.getDepositsWithMetConditions(deposits, currentBlock, hashSolvers);

    for (let deposit of deposits) {
      balance += deposit.active_balance;
    }

    return balance;
  }

  async streamStart() {

    const network_id = this.self.config.get('network.id')

    this.self.logger.debug('current network_id', network_id)

    let startBlock =
      (
        (await this.stateHeaders.findOne({
          id: 'hive_head',
        })) || ({} as any)
      ).block_num || networks[network_id].genesisDay

    if (this.self.config.get('debug.startBlock') !== undefined && this.self.config.get('debug.startBlock') !== null) {
      startBlock = +this.self.config.get('debug.startBlock');
    }

    if (this.self.config.get('debug.startAtCurrentBlock')) {
      const currentBlock = await HiveClient.blockchain.getCurrentBlock();
      const block_height = parseInt(currentBlock.block_id.slice(0, 8), 16);
      startBlock = block_height;
    }

    this.self.logger.debug('starting block stream at height', startBlock)
    this.hiveStream = await fastStream.create({
      //startBlock: networks[network_id].genesisDay,
      startBlock: startBlock,
      trackHead: true
    })
    await this.hiveStream.init()
    void (async () => {
      try {

        for await (let [block_height, block] of this.hiveStream.streamOut) {
          this.block_height = block_height;
          for(let tx of block.transactions) {
            try {
              const headerOp = tx.operations[tx.operations.length - 1]
              if(headerOp[0] === "custom_json") {
                if (headerOp[1].required_posting_auths.includes(networks[this.self.config.get('network.id')].multisigAccount)) {
                  try {
                    const json = JSON.parse(headerOp[1].json)
                    
                    // await this.self.transactionPool.transactionPool.findOneAndUpdate({
                    //   id: json.ref_id
                    // }, {
                    //   $set: {
                    //     'output_actions.$.ref_id': tx.id
                    //   }
                    // })
                  } catch {
    
                  }
                }
              }
              for(let [op_id, payload] of tx.operations) {
                // if(payload.json_metadata && payload.memo_key) {
                //   console.log(op_id, payload)
                // }
                
                if(op_id === "account_update") {
                  try {
                    const json_metadata = JSON.parse(payload.json_metadata)
                    if (json_metadata.vsc_node) {
                      const { payload: proof, kid } = await this.self.identity.verifyJWS(json_metadata.vsc_node.signed_proof)
                      const [did] = kid.split('#')
                      console.log(proof)
    
    
                      const witnessRecord = await this.witnessDb.findOne({
                        account: payload.account
                      }) || {} as any
    
                      const opts = {}
                      if((witnessRecord.enabled === true && proof.witness.enabled === false) || typeof witnessRecord.disabled_at === 'undefined') {
                        opts['disabled_at'] = block_height
                        opts["disabled_reason"] = proof.witness.disabled_reason
                      } else if((proof.witness.enabled === true && typeof witnessRecord.disabled_at === 'number') || typeof witnessRecord.enabled_at === 'undefined' ) {
                        opts['enabled_at'] = block_height
                        opts['disabled_at'] = null
                        opts['disabled_reason'] = null
                      }
    
                      if(json_metadata.did_auths) {
                        const did_auths = json_metadata.did_auths as DidAuth
    
                        const currentDidAuths = (await this.didAuths.find({
                          account: payload.account,
                          did: {$in: Object.keys(did_auths)}
                        }).toArray())
    
                        await this.didAuths.updateMany({
                          _id: {
                            $nin: currentDidAuths.map(e => e._id)
                          }
                        }, {
                          $set: {
                            valid_to: payload.account
                          }
                        })
    
                        const unindexdDids = did_auths
                        for(let cta of currentDidAuths) {
                          if(unindexdDids[cta.did] && unindexdDids[cta.did].ats === cta.authority_type) {
                            delete unindexdDids[cta.did];
                          }
                        }
    
                        for(let [did, val] of Object.entries(unindexdDids)) {
                          await this.didAuths.findOneAndUpdate({
                            did: did,
                            account: payload.account,
                            // valid_to: {
                            //   $ne: null
                            // }
                          }, {
                            $set: {
                              authority_type: val.ats,
                              valid_from: block_height,
                              valid_to: null
                            }
                          }, {
                            upsert: true
                          })
                        }
                      }
    
                      await this.witnessDb.findOneAndUpdate({
                        account: payload.account,
                      }, {
                        $set: {
                          did,
                          peer_id: proof.ipfs_peer_id,
                          signing_keys: proof.witness.signing_keys,
                          enabled: proof.witness.enabled,
                          last_signed: new Date(proof.ts),
                          net_id: proof.net_id,
                          git_commit: proof.git_commit,
                          plugins: proof.witness.plugins || [],
                          last_tx: tx.transaction_id,
                          ...opts
                        }
                      }, {
                        upsert: true
                      })
                    }
                  } catch(ex) {
                    if(!ex.message.includes('Unexpected end of JSON input')) {
                      console.log(ex)
                    }
                  }
                }
                if (op_id === "custom_json") {
                  if (payload.id === 'vsc-testnet-hive' || payload.id.startsWith('vsc.')) {
                    const json = JSON.parse(payload.json)
                    await this.processCoreTransaction(tx, json, {
                      account: payload.required_posting_auths[0],
                      block_height,
                      timestamp: new Date(block.timestamp + "Z")
                    })   
                  }
                } else if (op_id === "transfer") {
                  // console.log(payload)
                  // checking for to and from tx to be the multisig account, because all other transfers are not related to vsc
                  if ([payload.to, payload.from].includes(networks[this.self.config.get('network.id')].multisigAccount)) {
                    if (payload.memo) {
                      const json = JSON.parse(payload.memo)
                        await this.processCoreTransaction(tx, json, {
                          account: payload.from, // from or payload.required_posting_auths[0]?
                          block_height,
                          timestamp: new Date(block.timestamp + "Z"),
                          amount : payload.amount,
                          to: payload.to,
                          memo: payload.memo
                        })
                    } else {
                      this.self.logger.warn('received transfer without memo, considering this a donation as we cant assign it to a specific network', payload)
                    }     
                  }         
                }  
              }           
            } catch(ex) {
              console.log(ex)
            }
          }
  
          if (this.self.config.get('debug.debugNodeAddresses')?.includes(this.self.config.get('identity.nodePublic'))) {
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
  
          for (let i = this.multiSigWithdrawBuffer.length - 1; i >= 0; i--) {
            const withdraw = this.multiSigWithdrawBuffer[i];
            // ensure that there is a safe distance between the receival of the withdraw request and the current block
            const SAFE_BLOCK_DISTANCE = 5
            if (withdraw.create_block.included_block + SAFE_BLOCK_DISTANCE < block_height) {
              const multisigBalanceController = withdraw.controllers.find(c => c.authority === networks[this.self.config.get('network.id')].multisigAccount)
  
              if (multisigBalanceController) {
                const withdrawLock = <WithdrawLock>multisigBalanceController.conditions.find(c => c.type === 'WITHDRAW')
                
                if (withdrawLock && withdrawLock.expiration_block > block_height) {
                  this.self.logger.info(`withdraw request for deposit ${withdraw.id} has been finalized`)
                  // sign the balance update and publish via p2p multisig
                  // maybe do some more checks/ verifications to ensure that everything is working as intended
                }
              }
  
              // when we get to this point, something has gone wrong OR we successfully signed and proposed the withdraw
              // in an error case either the request is expired, something is wrong with the data and so on
              // we remove the withdraw request from the buffer
              this.multiSigWithdrawBuffer.splice(i, 1);
            }
          }
        }
      } catch (ex) {
        console.log(ex)
      }
    })()
    this.hiveStream.startStream()
  }

  async streamStop() {

  }

  /**
   * Verifies streaming is working correctly
   */
  async streamCheck() {
    if (this.hiveStream.blockLag > 300 && typeof this.hiveStream.blockLag === 'number') {
      // await this.self.nodeInfo.announceNode({
      //   action: "disable_witness",
      //   disable_reason: "sync_fail"
      // })

      await this.self.nodeInfo.setStatus({
        id: "out_of_sync",
        action: "disable_witness",
        expires: moment().add('1', 'day').toDate()
      })
    }

    if (this.syncedAt !== null) {
      if (this.hiveStream.blockLag > 300) {
        // await this.self.nodeInfo.announceNode({
        //   action: "disable_witness",
        //   disable_reason: "sync_fail"
        // })

        await this.self.nodeInfo.setStatus({
          id: "out_of_sync",
          action: "disable_witness",
          expires: moment().add('1', 'day').toDate()
        })


        this.hiveStream.killStream()
        this.streamStart()
        this.syncedAt = null


        return;
      }
      if (moment.isDate(this.hiveStream.lastBlockTs) && moment().subtract('1', 'minute').toDate().getTime() > this.hiveStream.lastBlockTs.getTime()) {
        console.log('KILLING STREAM', this.hiveStream.blockLag)

        this.hiveStream.killStream()
        this.streamStart()

        this.syncedAt = null

        return
      }
    }
    if (this.syncedAt === null && typeof this.hiveStream.blockLag === 'number' && this.hiveStream.blockLag < 5) {
      console.log('[streamCheck] System synced!')
      this.syncedAt = new Date();
      await this.self.nodeInfo.nodeStatus.deleteMany({
        id: "out_of_sync",
      })
    }
  }

  async start() {
    this.stateHeaders = this.self.db.collection('state_headers')
    this.blockHeaders = this.self.db.collection<BlockHeader>('block_headers')
    this.witnessDb = this.self.db.collection('witnesses')
    this.balanceDb = this.self.db.collection('balances')
    this.didAuths = this.self.db.collection('did_auths')

    if(process.env.HIVE_ACCOUNT_POSTING) {
      this.hiveKey = PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING)
    }

    this.ipfsQueue = new (await import('p-queue')).default({ concurrency: 4 })
    this.multiSigWithdrawBuffer = [] 

    this.witness = new WitnessService(this.self)

    this.streamOut = Pushable()
    
    
    
    if(this.self.mode !== 'lite') {
      
      this.events.on('vsc_block', (block) => {
        this.streamOut.push(block)
      })
      
      NodeSchedule.scheduleJob('* * * * *', async () => {
        await this.verifyMempool()
      })
          
      // console.log(new Date().getTime() - date.getTime(), blist.length)
      setInterval(() => {
        this.streamCheck()
      }, 5000)
      await this.streamStart()

      const network_id = this.self.config.get('network.id')

    void (async () => {
      for await (let block of this.streamOut) {
        console.log('vsc block', block)

        const blockContent = (await this.self.ipfs.dag.get(CID.parse(block.block_hash))).value

        console.log(blockContent)
        await this.blockHeaders.insertOne({
          height: await this.countHeight(block.block_hash),
          id: block.block_hash,
          hive_ref_block: block.tx.block_num,
          hive_ref_tx: block.tx.transaction_id,
          hive_ref_date: block.timestamp
          // witnessed_by: {
          //   hive_account: block.tx.posting
          // }
        })

        for (let tx of blockContent.txs) {

          // pla: pin vsc tx on enabled nodes, note: every dag.get/ cat is a pin via an overridden base function
          if (this.self.config.get('ipfs.pinEverything')) {
            const signedTransaction: DagJWS = (await this.self.ipfs.dag.get(CID.parse(tx.id))).value;
            this.self.ipfs.pin.add((signedTransaction as any).link as CID)
          }

          this.processVSCBlockTransaction(tx, block.block_hash);
          }
        }
      })()

      let lastEventCapture: number | null = null;
  
      let blkNum;
      setInterval(async() => {
        const diff = (blkNum - this.hiveStream.blockLag) || 0
        blkNum = this.hiveStream.blockLag
        
        const stateHeader = await this.self.newService.chainBridge.streamState.findOne({
          id: 'last_hb_processed'
        })
        if(stateHeader) {
          const now = Date.now();
          const hourAgo = now - (1000 * 60 * 60);
          if (lastEventCapture === null || lastEventCapture >= hourAgo) {
            lastEventCapture = now;
            telemetry.captureEvent('hive_sync_status', {
              blockLag: this.self.newService.chainBridge.blockLag,
              streamRate: Math.round(diff / 15),
              parseLag: this.self.newService.chainBridge.streamParser.stream.calcHeight - stateHeader.val,
            })
          }
          this.self.logger.info(`blockLag blockLag=${this.self.newService.chainBridge.blockLag} streamRate=${Math.round(diff / 15)} parseLag=${this.self.newService.chainBridge.streamParser.stream.calcHeight - stateHeader.val}`)
        } else {
          this.self.logger.info(`blockLag`, {
            blockLag:this.self.newService.chainBridge.blockLag,
            streamRate: Math.round(diff / 15)
          })
        }
      }, 15 * 1000)
  
      let producingBlock = false;
      setInterval(async () => {
        if(!this.self.newService.chainBridge.streamParser?.stream) {
          return;
        }
        if (this.self.newService.chainBridge.streamParser.stream.blockLag < 5) {
          //Can produce a block
          const offsetBlock = this.self.newService.chainBridge.streamParser.stream.lastBlock //- networks[network_id].genesisDay
          if ((offsetBlock % networks[network_id].roundLength) === 0) {
            if (!producingBlock) {
              const nodeInfo = await this.witnessDb.findOne({
                did: this.self.identity.id
              })
              if (nodeInfo) {
                const scheduleSlot = this.self.witness.witnessSchedule?.find((e => {
                  return e.bn === offsetBlock
                }))
                //console.log('scheduleSlot', scheduleSlot, offsetBlock)
                if (nodeInfo.enabled) {
  
  
                  if (scheduleSlot?.did === this.self.identity.id) {
                    this.self.logger.info('Can produce block!! at', this.hiveStream.lastBlock)
                    producingBlock = true;
                    await this.createBlock()
                  }
                }
              }
            }
          } else {
            producingBlock = false;
          }
        }
      }, 300)
    }
  }
}
