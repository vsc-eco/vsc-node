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
import { CreateContract } from '../types/transactions.js'
import { isNamedType } from 'graphql/type/definition.js'
import * as vm from 'vm';

const INDEX_RULES = {}





export class TransactionPoolService {
  self: CoreService
  transactionPool: Collection<WithId<TransactionDbRecord>>
  blockHeaders: Collection<WithId<BlockHeader>>

  constructor(self: CoreService) {
    this.self = self
  }

  async createTransaction(transactionRaw: TransactionRaw) {
    const transaction: TransactionContainer = {
      __t: 'vsc-tx',
      __v: '0.1',
      op: transactionRaw.op,
      payload: transactionRaw.payload,
      lock_block: 'null', //Calculate on the fly
      included_in: null,
      type: TransactionDbType.input,
    }

    const dag = await this.self.wallet.createDagJWS(transaction)
    //console.log(dag)
    const cid = await this.self.ipfs.dag.put(dag)


    try {
      await this.transactionPool.insertOne({
        id: cid.toString(),
        op: transaction.op,
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

  async createContract(args: { name: string; code: string }) {
    try {
      new vm.Script(args.code);
    } catch (err) {
      console.error(`provided script is invalid, not able to create contract\nid: {json.id}`);
    }
    
    // maybe its a good idea to check if the code already exists on ipfs by generating the CID
    // locally and then checking for it like with the existing method used in the verifymempool method?
    // https://stackoverflow.com/questions/60046604/node-less-way-to-generate-a-cid-that-matches-ipfs-desktop-cid

    // try {
    //   const out = await this.self.ipfs.dag.get(CID.parse(tx.id), {
    //     timeout: 10 * 1000,
    //   })
    //   ....
    // } catch {}
    
    const codeCid = await this.self.ipfs.add(args.code)
    console.log(codeCid)

    const {id} = await this.createTransaction({
        op: TransactionOps.createContract,
        payload: {
          action: 'create_contract',
          id: codeCid,
          name: args.name,
          code: args.code 
        } as CreateContract
    })
    console.log(id)
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
      const verify = await this.self.wallet.verifyJWS(json.payload)
      const { kid } = verify
      const [did] = kid.split('#')
      //console.log(did, verify)
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
