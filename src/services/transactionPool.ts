import { Collection, ObjectId, WithId } from 'mongodb'
import NodeSchedule from 'node-schedule'
import { encode, decode } from '@ipld/dag-cbor'
import { CID } from 'multiformats'
import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import BloomFilters from 'bloom-filters'
import { CoreService } from '.'
import { BlockHeader, TransactionContainer, TransactionDbRecord, TransactionDbStatus, TransactionDbType, TransactionRaw } from '../types'
import { VM, NodeVM, VMScript } from 'vm2'
import fs from 'fs/promises'
import { isNamedType } from 'graphql/type/definition.js'
import * as vm from 'vm';
import { PrivateKey } from '@hiveio/dhive'
import Crypto from 'crypto'
import { HiveClient, unwrapDagJws } from '../utils'
import { init } from '../transactions/core'
import { ContractManifest } from '../types/contracts'
import Axios from 'axios'
import { CoreBaseTransaction, CoreTransactionTypes, CreateContract, Deposit, EnableWitness, JoinContract, LeaveContract, Withdraw } from '../types/coreTransactions'
import { ContractInput, VSCTransactionTypes } from '../types/vscTransactions'
import { PeerChannel } from './pubsub'
const {BloomFilter} = BloomFilters

const INDEX_RULES = {}

export class TransactionPoolService {
  self: CoreService
  transactionPool: Collection<WithId<TransactionDbRecord>>
  blockHeaders: Collection<WithId<BlockHeader>>

  constructor(self: CoreService) {
    this.self = self
    HiveClient.broadcast.transfer
  }

  public static async createCoreTransferTransaction(to: string, amount: string, setup: {identity, config}, memo?: string) {
    //create transfer object
    const data = {
      from: process.env.HIVE_ACCOUNT!,
      to: to,
      amount: amount,
      memo: memo
    };
    
    return await HiveClient.broadcast.transfer(data, PrivateKey.from(process.env.HIVE_ACCOUNT_ACTIVE!))
  }

  // to convert the amount for a transfer, necessary as described here 
  // https://gitlab.syncad.com/hive/hive-js/tree/master/doc#transfer
  private static formatAmount(amount, assetSymbol) {
    const formattedAmount = Number(amount).toFixed(3);
    
    return `${formattedAmount} ${assetSymbol}`;
  }

  private static async createCoreTransaction(id: string, json: CoreBaseTransaction, setup: {identity, config, ipfsClient}) {
    return await HiveClient.broadcast.json({
      id: id,
      required_auths: [],
      required_posting_auths: [process.env.HIVE_ACCOUNT!],
      json: JSON.stringify(json)
    }, PrivateKey.from(process.env.HIVE_ACCOUNT_POSTING!))
  }

  async createTransaction(transactionRaw: any) {
    this.self.logger.info('Creating transaction')

    const latestBlockHeader = await this.blockHeaders.findOne({}, {
      sort: {
        height: -1
      }
    })

    let lock_block = 'null'

    if(latestBlockHeader) {
      lock_block = latestBlockHeader.id
    }

    const txContainer: TransactionContainer = {
      __t: 'vsc-tx',
      __v: '0.1',
      tx: transactionRaw,
      lock_block
    }

    const dag = await this.self.identity.createDagJWS(txContainer)

    const cid = await this.self.ipfs.dag.put({
      ...dag.jws,
      link: CID.parse(dag.jws['link'].toString()) //Glich with dag.put not allowing CIDs to link
    })
    const linkedBlock = await this.self.ipfs.block.put(dag.linkedBlock, {
      format: 'dag-cbor'
    })
    
    this.self.logger.debug('Create transaction dag info: ', dag.jws, cid, linkedBlock)

    try {
      const tx = await this.transactionPool.insertOne({
        _id: new ObjectId(),
        id: cid.toString(),
        op: txContainer.tx.op,
        account_auth: await this.self.wallet.id,
        local: true,
        lock_block: null,
        first_seen: new Date(),
        status: TransactionDbStatus.unconfirmed,
        type: transactionRaw.op === "contract_output" ? TransactionDbType.output : TransactionDbType.input,
        accessible: true,
        
        included_in: null,
        executed_in: null,
        output: null,
        headers: {
          contract_id: (txContainer.tx as any).contract_id
        },
        output_actions: (txContainer as any).tx.output_actions
      })
      this.self.logger.debug('injected tx into local db', tx)
    } catch (ex) {
      this.self.logger.error('not able to inject new tx into local db', ex)
    }

    // pla: lets define an interface for the pubsub transaction dto
    // ... what about 'TransactionUnconfirmed'?
    // await this.self.ipfs.pubsub.publish(
    //   '/vsc/memorypool',
    //   Buffer.from(
    //     JSON.stringify({
    //       type: 'tx_announce',
    //       tx_id: cid.toString(),
    //       payload: dag,
    //     }),
    //   ),
    // )
    await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
      payload: {
        id: cid.toString()
      },
      mode: 'basic'
    })

    // const transactionPoolHead = (
    //   await Block.encode({
    //     value: data,
    //     codec,
    //     hasher,
    //   })
    // ).cid
    return {
        id: cid.toString()
    }
  }

  static async enableWitness(setup: {identity, config, ipfsClient, logger}) {
    setup.logger.info('Enabling witness')

    const {data} = await Axios.post('http://localhost:1337/api/v1/graphql', {
        query: `
        {
            localNodeInfo {
              peer_id
              did
            }
          }
        `
    })

    const nodeInfo = data.data.localNodeInfo;
    setup.logger.debug('found local node peer id', nodeInfo)

    const json: EnableWitness = {
      net_id: setup.config.get('network.id'),
      node_id: nodeInfo.peer_id
    } as EnableWitness

    const result = await this.createCoreTransaction("vsc.enable_witness", json, setup)
    setup.logger.debug('result', result)
  }

  // pla: additional information about the value transfer is put into the memo field of the transaction
  // for some use cases, eg a deposit _to a contract_, this is necessary as we need the information of the target contract to deposit
  // if a user sends funds to the multi sig address without any attached data that tells us what he wants to do with his funds
  // we default to deposit it into his safe
  static async deposit(args: { amount: number, contractId?: string, to?: string }, setup: {identity, config, ipfsClient, logger}) {
    setup.logger.info(`Depositing funds (${args.amount}) to personal safe`)
    const memo = JSON.stringify({
      net_id: setup.config.get('network.id'),
      action: CoreTransactionTypes.deposit,
      to: args.to
    } as Deposit)

    if (args.contractId) {
      memo['contract_id'] = args.contractId
    }

    const result = await TransactionPoolService.createCoreTransferTransaction('vsc.beta', TransactionPoolService.formatAmount(args.amount, 'HIVE'), setup, memo)

    setup.logger.debug('result', result)
    return result;
  }

  static async withdraw(args: { amount: number}, setup: {identity, config, ipfsClient, logger}) {
    setup.logger.info(`Withdrawing funds (${args.amount}) from personal account`)

    const json = {
      net_id: setup.config.get('network.id'),
      amount: args.amount
    } as Withdraw

    const result = await TransactionPoolService.createCoreTransaction("vsc.create_contract", json, setup)
    setup.logger.debug('result', result)
    return result;
  }

  static async createContract(args: { name: string; code: string, description: string }, setup: {identity, config, ipfsClient, logger}) {
    setup.logger.info('Creating contract')
    setup.logger.debug('Creating contract. Details:', args)
    try {
      new vm.Script(args.code);
    } catch (err) {
      setup.logger.error(`provided script is invalid, not able to create contract\n`, err);  
      process.exit(0)
    }
    
    let codeCid = null;
    try {
      codeCid = await setup.ipfsClient.add(args.code)
    } catch {
      codeCid = await setup.ipfsClient.add(args.code, {onlyHash: true})
    }

    let codeManifest = JSON.stringify({
      name: args.name,
      description: args.description,
      controllers: [ setup.identity.id ],
      code: codeCid.path,
      lock_block: '' // pla: to be filled
    } as ContractManifest);

    let codeManifestCid = null;
    try {
      codeManifestCid = await setup.ipfsClient.add(codeManifest)
    } catch {
      codeManifestCid = await setup.ipfsClient.add(codeManifest, {onlyHash: true})
    }

    const json = {
      manifest_id: codeManifestCid.path,
      action: 'create_contract',
      name: args.name,
      code: codeCid.path,
      net_id: setup.config.get('network.id')
    } as CreateContract

    const result = await TransactionPoolService.createCoreTransaction("vsc.create_contract", json, setup)
    setup.logger.debug('result', result)
    return result;
  }

  public async callContract(contract_id: string, args: {action, payload: any}) {
    this.self.logger.info('Invoking contract')
    this.self.logger.debug('Invoking contract details', contract_id, args.payload)

    let contractInput: ContractInput = {
      action: args.action,
      contract_id: contract_id,
      payload: args.payload,
      salt: Crypto.randomBytes(8).toString('base64url')
    } as ContractInput

    //Signed here

    let callContractTx: TransactionRaw = {
      op: VSCTransactionTypes.call_contract,
      type: TransactionDbType.input,
      ...contractInput,
    }

    this.self.logger.debug('call contract transaction dto', callContractTx)
    return await this.createTransaction(callContractTx)
  }

  private static async contractCommitmentOperation(args: { contract_id }, setup: {identity, config, ipfsClient, logger}, action: CoreTransactionTypes.create_contract | CoreTransactionTypes.leave_contract) {
    const {data} = await Axios.post('http://localhost:1337/api/v1/graphql', {
      query: `
      {
          localNodeInfo {
            peer_id
            did
          }
        }
      `
    })
    const nodeInfo = data.data.localNodeInfo;
    setup.logger.debug('found local node peer id', nodeInfo)
    
    const json: JoinContract | LeaveContract = {
      action: CoreTransactionTypes.join_contract,
      contract_id: args.contract_id,
      node_id: nodeInfo.peer_id,
      node_identity: setup.identity.id,
      net_id: setup.config.get('network.id')
    }

    const result = TransactionPoolService.createCoreTransaction(`vsc.${action}`, json, setup)
    setup.logger.debug(`result of ${action} operation`, result)
  }

  static async joinContract(args: { contract_id }, setup: {identity, config, ipfsClient, logger}) {
    this.contractCommitmentOperation(args, setup, CoreTransactionTypes.create_contract);
  }

  static async leaveContract(args: { contract_id }, setup: {identity, config, ipfsClient, logger}) {
    this.contractCommitmentOperation(args, setup, CoreTransactionTypes.leave_contract);
  }

  async initiateWithdraw() {

  }

  async initiateTransfer(from: string, to: string, amount: number) {
    const isMultisigApproved = true; 
    if (isMultisigApproved) {
      // UPDATE DATABASE DEPOSIT ENTRIES HERE, NO DONT DO THAT, WE NEED A NEW TRANSFER TYPE FOR "MULTISIG CONFIRMED TRANSFER" THAT IS THEN INTERPRETED BY EVERY NODE
      // finalize and settle the approved transaction
      // TransactionPoolService.createCoreTransferTransaction(); 
    }
  }

  async processMempoolTX(txId: string) {
    let auths = []
    try {
      
      const alreadyExistingTx = await this.transactionPool.findOne({
        id: txId.toString()
      })
      
      let local;
      if(!alreadyExistingTx) {
        local = false;

        const transactionRaw: ContractInput = (await this.self.ipfs.dag.get(CID.parse(txId))).value
        const {content, auths: authsOut} = await unwrapDagJws(transactionRaw, this.self.ipfs, this.self.identity)
        auths = authsOut;
        
        await this.transactionPool.findOneAndUpdate({
          id: txId.toString(),
        }, {
          $set: {
            account_auth: auths[0],
            op: content.tx.op,
            lock_block: null,
            status: TransactionDbStatus.unconfirmed,
            first_seen: new Date(),
  
            type: TransactionDbType.input,
            included_in: null,
  
            executed_in: null,
            output: null,
            
            local,
            accessible: true,
            headers: {
              contract_id: content.tx.contract_id
            }
          }
        }, {
          upsert: true
        })
      }

    } catch (e) {
      console.log(e)
      this.self.logger.error("not able to receive contract from local ipfs node ", txId)
    }
    

  }

  channelRegister(channel: PeerChannel) {
    console.log('registering 30')
    channel.register('announce_tx', async({from, message, drain, sink}) => {
      // this.self.logger.debug('test registration', {from, message, drain, sink})
      

      // console.log('tx', {message, from})
      await this.processMempoolTX(message.id)
      drain.end()
    }, {
      loopbackOk: true
    })
  }

  async start() {
    this.transactionPool = this.self.db.collection('transaction_pool')
    this.blockHeaders = this.self.db.collection('block_headers')

    try {
      await this.transactionPool.createIndex(
        {
          id: 1,
        },
        {
          unique: true,
        },
      )
    } catch {}

    // setInterval(async() => {
    //   const ids = await this.transactionPool.distinct('id', {

    //   })

    //   const bf = BloomFilter.from(ids, 0.001).saveAsJSON()
    //   this.self.p2pService.memoryPoolChannel.call('announce_tx', {
    //     payload: {
    //       tx: "hello world",
    //       bf: {
    //         _size: bf._size,
    //         _nbHashes: bf._nbHashes,
    //         _filter: bf._filter,
    //         _seed: bf._seed
    //       }
    //     },
    //     mode: "basic"
    //   })
    // }, 600000)

    // pla: DBG
    try {
      const newCid = (await this.self.ipfs.add(await fs.readFile('./src/services/contracts/basic-contract.js'))).cid.toString()
      // await this.updateContract({
      //   id: "kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz",
      //   name: 'test contract',
      //   codeCid: newCid
      // })

    } catch(ex) {
      this.self.logger.error('failed to inject basic contract into local ipfs node', ex)
    }
  }
}
