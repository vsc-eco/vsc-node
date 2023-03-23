import { Collection, ObjectId, WithId } from 'mongodb'
import NodeSchedule from 'node-schedule'
import { encode, decode } from '@ipld/dag-cbor'
import { CID } from 'multiformats'
import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { BloomFilter } from 'bloom-filters'
import { CoreService } from '.'
import { BlockHeader, TransactionContainer, TransactionDbRecord, TransactionDbStatus, TransactionDbType, TransactionRaw } from '../types'
import { VM, NodeVM, VMScript } from 'vm2'
import fs from 'fs/promises'
import { isNamedType } from 'graphql/type/definition.js'
import * as vm from 'vm';
import { PrivateKey } from '@hiveio/dhive'
import Crypto from 'crypto'
import { HiveClient } from '../utils'
import { init } from '../transactions/core'
import { ContractManifest } from '../types/contracts'
import Axios from 'axios'
import { CoreBaseTransaction, CoreTransactionTypes, CreateContract, EnableWitness, JoinContract, LeaveContract } from '../types/coreTransactions'
import { ContractInput, VSCTransactionTypes } from '../types/vscTransactions'

const INDEX_RULES = {}

export class TransactionPoolService {
  self: CoreService
  transactionPool: Collection<WithId<TransactionDbRecord>>
  blockHeaders: Collection<WithId<BlockHeader>>

  constructor(self: CoreService) {
    this.self = self
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
    const txContainer: TransactionContainer = {
      __t: 'vsc-tx',
      __v: '0.1',
      tx: transactionRaw,
      lock_block: 'null', //Calculate on the fly 
    }

    const dag = await this.self.wallet.createDagJWS(txContainer)

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
        }
      })
      console.log(tx)
    } catch (ex) {
      console.log(ex)
    }

    // pla: lets define an interface for the pubsub transaction dto
    // ... what about 'TransactionUnconfirmed'?
    await this.self.ipfs.pubsub.publish(
      '/vsc/memorypool',
      Buffer.from(
        JSON.stringify({
          type: 'tx_announce',
          tx_id: cid.toString(),
          payload: dag,
        }),
      ),
    )

    // const transactionPoolHead = (
    //   await Block.encode({
    //     value: data,
    //     codec,
    //     hasher,
    //   })
    // ).cid
    //console.log('head', transactionPoolHead.toString())
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

    const result = this.createCoreTransaction("vsc.enable_witness", json, setup)
    setup.logger.debug('result', result)
  }

  static async createContract(args: { name: string; code: string, description: string }, setup: {identity, config, ipfsClient, logger}) {
    setup.logger.info('Creating contract')
    setup.logger.debug('Creating contract. Details:', args)
    try {
      new vm.Script(args.code);
    } catch (err) {
      console.error(`provided script is invalid, not able to create contract\n`, err);  
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
  }

  public async callContract(contract_id: string, payload: any) {
    this.self.logger.info('Invoking contract')
    this.self.logger.debug('Invoking contract details', contract_id, payload)

    let contractInput: ContractInput = {
      contract_id: contract_id,
      payload: payload,
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

    this.self.ipfs.pubsub.subscribe('/vsc/memorypool', async (data) => {
      const json = JSON.parse(String.fromCharCode.apply(null, data.data))
      //console.log(json)
      // const verify = await this.self.wallet.verifyJWS(json.payload)
      // const { kid } = verify
      // const [did] = kid.split('#')
      // //console.log(did, verify)
    })

    // pla: DBG
    try {
      const newCid = (await this.self.ipfs.add(await fs.readFile('./src/services/contracts/basic-contract.js'))).cid.toString()
      console.log('new contract cid', newCid)
      // await this.updateContract({
      //   id: "kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz",
      //   name: 'test contract',
      //   codeCid: newCid
      // })

    } catch(ex) {
      console.log(ex)
    }
  }
}
