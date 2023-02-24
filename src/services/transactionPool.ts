import { Collection, WithId } from 'mongodb'
import NodeSchedule from 'node-schedule'
import { encode, decode } from '@ipld/dag-cbor'
import { CID } from 'multiformats'
import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { BloomFilter } from 'bloom-filters'
import { CoreService } from '.'
import { BlockHeader, TransactionContainer, TransactionDbRecord, TransactionDbStatus, TransactionDbType, TransactionOps, TransactionRaw } from '../types'
import { CommitID } from '@ceramicnetwork/docid'
import { VM, NodeVM, VMScript } from 'vm2'
import { TileDocument } from '@ceramicnetwork/stream-tile'
import fs from 'fs/promises'
import { CreateContract } from '../types/transactions'
import { isNamedType } from 'graphql/type/definition.js'
import * as vm from 'vm';
import { PrivateKey } from '@hiveio/dhive'
import { HiveClient } from '../utils'
import { init } from '../transactions/core'
import { ContractManifest } from '../types/contracts'
import Axios from 'axios'
import { JoinContract } from '../types/transactions'
import { TransactionTypes } from '../types/transactions'
import { ContractInput, TransactionRaw, VSCOperations } from '@/types/index'
import { BaseTransaction } from '@/types/transactions'
import { LeaveContract } from '@/types/transactions.js'

const INDEX_RULES = {}





export class TransactionPoolService {
  self: CoreService
  transactionPool: Collection<WithId<TransactionDbRecord>>
  blockHeaders: Collection<WithId<BlockHeader>>

  constructor(self: CoreService) {
    this.self = self
  }

  private static async createCoreTransaction(id: string, json: BaseTransaction, setup: {identity, config, ipfsClient}) {
    return await HiveClient.broadcast.json({
      id: id,
      required_auths: [],
      required_posting_auths: [process.env.HIVE_ACCOUNT!],
      json: JSON.stringify(json)
    }, PrivateKey.from(process.env.HIVE_ACCOUNT_POSTING!))
  }

  async createTransaction(transactionRaw: TransactionRaw) {

    const txContainer: TransactionContainer = {
      __t: 'vsc-tx',
      __v: '0.1',
      tx: transactionRaw,
      lock_block: 'null', //Calculate on the fly
      included_in: null    
    }

    const dag = await this.self.wallet.createDagJWS(txContainer)
    //console.log(dag)
    const cid = await this.self.ipfs.dag.put(dag)

    try {
      await this.transactionPool.insertOne({
        id: cid.toString(),
        op: txContainer.tx.op,
        account_auth: await this.self.wallet.id,
        local: true,
        lock_block: null,
        first_seen: new Date(),
        status: TransactionDbStatus.unconfirmed,
        type: TransactionDbType.input,
        included_in: null,
        executed_in: null,
        accessible: true
      })
    } catch {}

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

    let obj = {}
    for (let hash of ['bafyreige4erd7ulmsqqbw32cyva5bimz5zamlk7mvtsv6662d7wu2oi56i']) {
      obj[hash] = ''
    }
    const data = encode(obj)

    const transactionPoolHead = (
      await Block.encode({
        value: data,
        codec,
        hasher,
      })
    ).cid
    //console.log('head', transactionPoolHead.toString())
    return {
        id: cid.toString()
    }
  }

  static async createContract(args: { name: string; code: string, description: string }, setup: {identity, config, ipfsClient}) {
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

    const result = TransactionPoolService.createCoreTransaction("vsc.create_contract", json, setup)
    console.log(result)
  }

  public async callContract(contract_id: string, action: string, payload: any) {
    let contractInput: ContractInput = {
      contract_id: contract_id,
      action: action,
      payload: payload
    }

    let contractInputCid = null;
    try {
      contractInputCid = await this.self.ipfs.add(contractInput)
    } catch {
      contractInputCid = await this.self.ipfs.add(contractInput, {onlyHash: true})
    }

    let callContractTx: TransactionRaw = {
      op: VSCOperations.call_contract,
      payload: contractInputCid,
      type: TransactionDbType.input
    }

    this.createTransaction(callContractTx)
  }

  private static async contractCommitmentOperation(args: { contract_id }, setup: {identity, config, ipfsClient}, action: TransactionTypes.create_contract | TransactionTypes.leave_contract) {
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
    
    const json: JoinContract | LeaveContract = {
      action: action,
      contract_id: args.contract_id,
      node_id: nodeInfo.peer_id,
      node_identity: setup.identity.id,
      net_id: setup.config.get('network.id')
    }

    const result = TransactionPoolService.createCoreTransaction(`vsc.${action}`, json, setup)
    console.log(result)
  }

  static async joinContract(args: { contract_id }, setup: {identity, config, ipfsClient}) {
    this.contractCommitmentOperation(args, setup, TransactionTypes.create_contract);
  }

  static async leaveContract(args: { contract_id }, setup: {identity, config, ipfsClient}) {
    this.contractCommitmentOperation(args, setup, TransactionTypes.leave_contract);
  }

  async updateContract(args: {
    id: string
    codeCid?: string
    name?: string
  }) {
    const tileDoc = await TileDocument.load(
      this.self.ceramic,
      args.id,
    )
    
    if(!tileDoc.metadata.controllers.includes(this.self.wallet.id)) {
      throw new Error('Cannot modify a contract you do not own')
    }
    
    if(((tileDoc.content as any).code === args.codeCid.toString())) {
      throw new Error('Cannot update to same codeCid')
    }

    await tileDoc.update({
      name: args.name,
      code: args.codeCid.toString(),
      revision: ((tileDoc.content as any).revision || 0) + 1
    } as any)

    const {id} = await this.createTransaction({
      op: TransactionOps.updateContract,
      payload: {
        stream_id: tileDoc.id.toString(),
        commit_id: tileDoc.commitId.toString()
      }
    })
    return {
      transaction_id: id,
      stream_id: tileDoc.id.toString(),
      commit_id: tileDoc.commitId.toString()
    }
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

   
    await this.createTransaction({
      op: 'announce_node',
      payload: {
        peer_id: (await this.self.ipfs.id()).id,
      },
    })

    const vmState = {
      api: {},
    }

    // const vm = new NodeVM({
    //   sandbox: {
    //     test: async () => {
    //       return await this.self.ipfs.id()
    //     },
    //   },
    // })

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

    /*const out = vm.run(
      `
        Math.random = () => {}
        RegExp.prototype.constructor = function () { };
        RegExp.prototype.exec = function () {  };
        RegExp.prototype.test = function () {  };
      
      async function main() {
        console.log(Math.random())
      }
      main();
    `,
      'vm.js',
    )
    console.log(out)*/
  }
}
