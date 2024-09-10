import { CID } from 'multiformats'
import { appContainer } from '../index'
import { GraphQLError } from 'graphql';
import * as IPFS from 'kubo-rpc-client'
import sift from 'sift'
import DAGCbor from 'ipld-dag-cbor'
import { convertTxJws } from '@vsc.eco/client/dist/utils'
import Ajv from "ajv"
import { TransactionDbStatus, TransactionDbType } from '../../../types';
import { computeKeyId, verifyTx } from '../../../services/new/utils';
import { TransactionContainerV2, WitnessDbRecord } from '../../../services/new/types';
import { HiveClient } from '../../../utils';
import { diff } from 'json-diff';

const ajv = new Ajv() // options can be passed, e.g. {allErrors: true}

ajv.compile({
  type: "object",
  properties: {
    headers: {
      type: "object",
      properties: {

      }
    },
  },
  required: ["hea"],
  additionalProperties: false
})

async function fetchState(key: string, stateMerkle: string) {
  try {
    const obj = await appContainer.self.ipfs.dag.resolve(stateMerkle, {
      path: key,
    })
    const out = await appContainer.self.ipfs.dag.get(obj.cid)
    console.log(out)

    const recursiveFetch = async (initialNode) => {
      let result = {}
      const dagVal = await appContainer.self.ipfs.dag.get(initialNode.Hash)
      if ('Links' in dagVal.value) {
        for (let link of dagVal.value.Links as any) {
          result[link.Name] = await recursiveFetch(link)
        }
      } else {
        return dagVal.value
      }

      return result
    }

    if (key === null) {
      let recursiveOutput = {}
      for (let key of out.value.Links) {
        recursiveOutput[key.Name] = await recursiveFetch(key)
      }
      return recursiveOutput;
    }

    return out.value
  } catch {
    return null;
  }
}

export const DebugResolvers = {
  peers: async (_, args) => {

  },
  openChannels: async (_, args) => {

  }
}

export const Resolvers = {
  contractStateDiff: async (_, args) => {
    const inputTxMatchingOutputTx = await appContainer.self.newService.chainBridge.contractOutputDb.findOne(
      { inputs: { $elemMatch: { $eq: args.id } } }
    );

    const previousContractOutputTx = await appContainer.self.newService.chainBridge.contractOutputDb.findOne(
      { _id: { $lt: inputTxMatchingOutputTx._id } },
      { limit: 1, sort: [['_id', -1]] }
    );

    const outputTxState = await fetchState(null, inputTxMatchingOutputTx.state_merkle);
    const previousContractState = await fetchState(null, previousContractOutputTx.state_merkle);

    return {
      diff: diff(previousContractState, outputTxState)
    }
  },
  contractState: async (_, args) => {
    const data = await appContainer.self.newService.chainBridge.contractOutputDb.findOne({
      id: args.id,
    }, {
      sort: {
        anchored_height: -1
      }
    })

    if (!data) {
      return null;
    }

    return {
      id: data.id,
      state_merkle: data.state_merkle,
      stateKeys: async (args) => {
        try {
          let key = args.key ? `${args.key}` : null
          const objCid = await appContainer.self.ipfs.dag.resolve(CID.parse(data.state_merkle), {
            path: key,
          })
          const obj2 = await appContainer.self.ipfs.dag.get(objCid.cid)
          if (obj2.value.Links) {
            return obj2.value.Links.map(e => {
              return {
                ...e,
                Hash: e.Hash.toString()
              }
            })
          } else {
            return []
          }
        } catch (ex) {
          console.log(ex)
          return null;
        }
      },
      stateQuery: async (args) => {
        try {
          let key = args.key ? `${args.key}` : null
          const objCid = await appContainer.self.ipfs.dag.resolve(CID.parse(data.state_merkle), {
            path: key,
          })
          const obj2 = await appContainer.self.ipfs.dag.get(objCid.cid)
          if (obj2.value.Links) {
            const out = await Promise.all(obj2.value.Links/*.map(e => {
              return e.Hash
            })*/.map(async (e) => {
              return {
                ...(await appContainer.self.ipfs.dag.get(e.Hash)).value,
                _id: e.Name
              }
            }));

            // console.log(out, args.query)
            if (args.query) {
              return out.filter(sift(args.query))
            } else {
              return out
            }
          } else {
            return []
          }
        } catch (ex) {
          console.log(ex)
          return null;
        }
      },
      state: async (args) => {
          let key = args.key ? `${args.key}` : null
        return await fetchState(key, data.state_merkle)
      },
    }
  },
  findContractOutput: async (_, args) => {
    let query = {}
    let limit = 100

    if (args.filterOptions?.byInput) {
      query['inputs'] = { $in: [args.filterOptions.byInput] };
    }

    if (args.filterOptions?.byOutput) {
      query['id'] = args.filterOptions.byOutput
    }

    if (args.filterOptions?.byContract) {
      query['contract_id'] = args.filterOptions.byContract
    }

    if (args.filterOptions?.limit && args.filterOptions?.limit < 100) {
      limit = args.filterOptions.limit
    }

    const txs = await appContainer.self.newService.chainBridge.contractOutputDb.find({
      ...query
    }, {
      limit: limit,
      skip: 0,
      sort: {
        anchored_height: -1
      }
    }).toArray()

    return {
      outputs: txs
    }
  },
  findTransaction: async (_, args) => {
    let query = {}
    let limit = 100

    if (args.filterOptions?.byId) {
      query['id'] = args.filterOptions.byId
    }

    if (args.filterOptions?.byStatus) {
      query['status'] = args.filterOptions.byStatus
    }

    if (args.filterOptions?.byContract) {
      query['data.contract_id'] = args.filterOptions.byContract
    }

    if (args.filterOptions?.byAccount) {
      query['required_auths'] = { $elemMatch: { value: args.filterOptions.byAccount } };
    }

    if (args.filterOptions?.byOpCategory) {
      query['data.op'] = args.filterOptions.byOpCategory
    }

    if (args.filterOptions?.byAction) {
      query['data.action'] = args.filterOptions.byAction
    }

    if (args.filterOptions?.limit && args.filterOptions?.limit < 100) {
      limit = args.filterOptions.limit
    }

    const txs = await appContainer.self.newService.transactionPool.txDb.find({
      ...query
    }, {
      limit: limit,
      skip: 0
    }).toArray()

    return {
      txs: txs.map(e => {
        return {
          ...e,
          first_seen: e.first_seen.toISOString(),
        }
      })
    }
  },
  findLedgerTXs: async (_, args) => {
    const hasFromArg = !!args.filterOptions?.byToFrom;
    const hasTxArg = !!args.filterOptions?.byTxId;
    if (hasFromArg === hasTxArg) {
      throw new GraphQLError('exactly 1 of filterOptions.byToFrom or filterOptions.byTxId is required')
    }
    const owner: string | undefined = args.filterOptions?.byToFrom;
    const limit = Math.min(100, Math.max(0, args.filterOptions?.limit ?? 20))
    const offset = Math.max(0, args.filterOptions?.offset ?? 0)
    const [deposits, withdrawalsAndtransfers] = await Promise.all([
      appContainer.self.newService.witness.balanceKeeper.ledgerDb.find({
        t: 'deposit',
        ...(owner ? {
        $or: [
          { owner },
          ...(owner.startsWith('hive:') ? [{ from: owner.slice('hive:'.length) }] : []),
        ],
      } : {
        id: args.filterOptions?.byTxId
      })
      }, {
        skip: offset,
        limit,
        sort: [
          ['block_height', -1]
          // TODO add tx op index
        ]
      }).toArray(),
      appContainer.self.newService.transactionPool.txDb.find({
        $and: [
          { $or: [{ 'data.op': 'transfer' }, { 'data.op': 'withdraw' }] },
          { ...(owner ? { $or: [{ 'data.payload.from': owner }, { 'data.payload.to': owner }] } : {id: args.filterOptions?.byTxId})},
        ],
      }, {
        skip: offset,
        limit,
        sort: [
          ['anchored_height', -1],
          ['anchored_index', -1],
        ]
      }).toArray(),
    ])

    type Tx = typeof deposits[number] & {status: TransactionDbStatus}

    const mapTxToLedgerOp = (tx: typeof withdrawalsAndtransfers[number]): Tx => ({
      id: tx.id,
      tk: tx.data.payload.tk,
      amount: tx.data.payload.amount,
      block_height: tx.anchored_height!,
      idx: tx.anchored_op_index!,
      owner: tx.data.payload.to,
      from: tx.data.payload.from,
      t: tx.data.op,
      memo: tx.data.payload.memo,
      status: tx.status,
      _id: tx._id,
    })
    
    const txs = deposits as Tx[]
    const originalDepositsLength = deposits.length
    let di = 0;
    let ti = 0;
    while (di < originalDepositsLength && ti < withdrawalsAndtransfers.length) {
      if (deposits[di + ti].block_height > withdrawalsAndtransfers[ti].anchored_height!) {
        txs[di + ti].status = TransactionDbStatus.confirmed
        di++;
      } else {
        deposits.splice(di+ti, 0, mapTxToLedgerOp(withdrawalsAndtransfers[ti]));
        ti++
      }
    }

    if (ti < withdrawalsAndtransfers.length) {
      deposits.push(...withdrawalsAndtransfers.slice(ti).map(mapTxToLedgerOp))
    }

    for (; di < originalDepositsLength; di++) {
      txs[di + ti].status = TransactionDbStatus.confirmed
    }

    console.log(JSON.stringify({originalDepositsLength, withdrawalsAndtransfers: withdrawalsAndtransfers.length}, null, 2))

    return {
      txs,
    };
  },
  localNodeInfo: async () => {
    const idInfo = await appContainer.self.ipfs.id()
    return {
      peer_id: idInfo.id
    }
  },
  witnessNodes: async (_, args): Promise<WitnessDbRecord[]> => {
    if (!args.height) {
      args.height = await appContainer.self.newService.chainBridge.getLatestBlock()
    }
    //Use getWitnessesAtBlock to get witnesses in general
    //TODO: Create separate API to include indicate whether a node is in the schedule or not.
    return await appContainer.self.newService.chainBridge.getWitnessesAtBlock(args.height)
  },
  activeWitnessNodes: async (_, args) => {
    if (!args.height) {
      args.height = await appContainer.self.newService.chainBridge.getLatestBlock()
    }
    return await appContainer.self.newService.electionManager.getMembersOfBlock(args.height)
  },
  witnessSchedule: async (_, args) => {
    if (!args.height) {
      args.height = await appContainer.self.newService.chainBridge.getLatestBlock()
    }
    return await appContainer.self.newService.witness.getBlockSchedule(args.height)
  },
  nextWitnessSlot: async (_, args) => {
    let account
    if (args.self) {
      account = process.env.HIVE_ACCOUNT
    }

    if (!args.height) {
      args.height = await appContainer.self.newService.chainBridge.getLatestBlock()
    }

    const nextSlot = (await appContainer.self.newService.witness.getBlockSchedule(args.height)).find(e => {
      if (account) {
        return e.in_past === false && e.account === account;
      } else {
        return e.in_past === false;
      }
    })
    return nextSlot;
  },
  submitTransactionV1: async (_, args) => {
    const { id } = await appContainer.self.newService.transactionPool.ingestTx({
      tx: args.tx,
      sig: args.sig,
      broadcast: true
    })
    return {
      id
    }
  },
  getAccountNonce: async (_, args) => {
    const nonceData = await appContainer.self.newService.nonceMap.findOne({
      id: await computeKeyId(args.keyGroup)
    })
    let nonce;
    if (nonceData) {
      nonce = nonceData.nonce
    } else {
      nonce = 0;
    }
    return {
      nonce
    }
  },
  getAccountBalance: async (_, args) => {
    const bh = await HiveClient.blockchain.getCurrentBlockNum()

    const snapshot = await appContainer.self.newService.witness.balanceKeeper.getSnapshot(args.account, bh);
    return {
      account: snapshot.account,
      tokens: {
        HBD: snapshot.tokens.HBD / 1_000,
        HIVE: snapshot.tokens.HIVE / 1_000,

      },
      block_height: snapshot.block_height
    }
  },
  witnessActiveScore: async (_, args) => {
    if (!args.height) {
      args.height = await HiveClient.blockchain.getCurrentBlockNum()
    }
    const bh = args.height
    return await appContainer.self.newService.witness.getWitnessActiveScore(bh)
  },
  mockGenerateElection: async (_, args) => {
    const bh = await HiveClient.blockchain.getCurrentBlockNum()
    return await appContainer.self.newService.electionManager.generateElection(bh)
  },
  anchorProducer: async (_, args) => {
    let { account } = args
    if (!account) {
      account = process.env.HIVE_ACCOUNT
    }
    const blockNum = await HiveClient.blockchain.getCurrentBlockNum();

    const schedule = await appContainer.self.newService.witness.getBlockSchedule(blockNum)

    const nextSlot = schedule.find(e => {
      return e.bn > blockNum && e.account === account
      // console.log(e)
    })

    return {
      nextSlot: {
        blocksTilSlot: nextSlot ? nextSlot.bn - blockNum : null,
      }
    }
  }
}
