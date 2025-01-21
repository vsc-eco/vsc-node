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

async function listAllEntries(
  cid: string,
  path: string = ''
): Promise<{ path: string; type: string; cid: string }[]> {
  const entriesList: { path: string; type: string; cid: string }[] = [];
  const entries = await appContainer.self.ipfs.ls(cid);

  for await (const entry of entries) {
    const fullPath = path ? `${path}/${entry.name}` : entry.name;
    entriesList.push({
      path: fullPath,
      type: entry.type,
      cid: entry.cid.toString(),
    });

    if (entry.type === 'dir') {
      const subEntries = await listAllEntries(entry.cid.toString(), fullPath);
      entriesList.push(...subEntries);
    }
  }

  return entriesList;
}

async function buildDataMap(rootCid: string): Promise<{ [key: string]: any }> {
  const dataMap: { [key: string]: any } = {};
  const entries = await listAllEntries(rootCid);

  for (const entry of entries) {
    const { path, type, cid } = entry;

    if (type === 'file') {
      try {
        dataMap[path] = (await appContainer.self.ipfs.dag.get(CID.parse(cid))).value!;
      } catch (error) {
        console.error(`Error fetching data at path ${path}:`, error);
      }
    } else if (type === 'dir') {
      // we dont return directories
    }
  }

  return dataMap;
}

async function fetchState(key: string, stateMerkle: string) {
  try {
    if (key === null) {
      return await buildDataMap(stateMerkle)
    } else {
      const obj = await appContainer.self.ipfs.dag.resolve(stateMerkle, {
        path: key,
      })
      const out = await appContainer.self.ipfs.dag.get(obj.cid)
      return out.value
    }
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

const calculateContractDiff = async (initialStateMerkle: string, outputStateMerkle) => {
  const previousContractState = await fetchState(null, initialStateMerkle);
  const outputTxState = await fetchState(null, outputStateMerkle);

  return diff(previousContractState, outputTxState)
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

    return {
      diff: calculateContractDiff.bind(null, previousContractOutputTx.state_merkle, inputTxMatchingOutputTx.state_merkle),
      previousContractStateId: previousContractOutputTx.id
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
          ['block_height', -1],
          ['idx', -1]
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
          ['anchored_op_index', -1],
          ['header.nonce', -1]
        ]
      }).toArray(),
    ])

    type Tx = typeof deposits[number] & {status: TransactionDbStatus}

    let unconfirmedOpCount = 0

    const mapTxToLedgerOp = (tx: typeof withdrawalsAndtransfers[number]): Tx => ({
      id: tx.id,
      tk: tx.data.payload.tk,
      amount: tx.data.payload.amount,
      block_height: tx.anchored_height || appContainer.self.newService.chainBridge.streamParser.stream.lastBlock,
      // TODO some txs that are not unconfirmed are missing anchored_op_index
      idx: parseFloat(`${tx.anchored_index || 0}.${tx.status === TransactionDbStatus.unconfirmed ? unconfirmedOpCount++ : tx.anchored_op_index || 0}`),
      owner: tx.data.payload.to,
      from: tx.data.payload.from,
      t: tx.data.op,
      memo: tx.data.payload.memo,
      status: tx.status,
      _id: tx._id,
    })
    
    const txs = deposits as Tx[]
    const unconfirmedTxs: Tx[] = []
    const originalDepositsLength = deposits.length
    let di = 0;
    let ti = 0;
    while (di < originalDepositsLength && ti < withdrawalsAndtransfers.length) {
      const i = di + ti - unconfirmedOpCount
      if (deposits[i].block_height > withdrawalsAndtransfers[ti].anchored_height!) {
        txs[i].status = TransactionDbStatus.confirmed
        txs[i].idx = 0
        di++;
      } else {
        const ledgerOp = mapTxToLedgerOp(withdrawalsAndtransfers[ti])
        if (ledgerOp.status === TransactionDbStatus.unconfirmed) {
          unconfirmedTxs.push(ledgerOp)
        } else {
          deposits.splice(i, 0, ledgerOp);
        }
        ti++
      }
    }
    const nums: number[] = []
    nums.push(di, ti, -1)

    if (ti < withdrawalsAndtransfers.length) {
      deposits.push(...withdrawalsAndtransfers.slice(ti).map(mapTxToLedgerOp))
    }

    for (; di < originalDepositsLength; di++) {
      const i = di + ti - unconfirmedOpCount
      nums.push(i)
      txs[i].status = TransactionDbStatus.confirmed
      txs[i].idx = 0
    }

    nums.push(-1)
    txs.unshift(...unconfirmedTxs)
    nums.push(originalDepositsLength, withdrawalsAndtransfers.length, unconfirmedOpCount, unconfirmedTxs.length, -1)
// [41, 42, 43, 44, 45, 46]
    let i = 0;
    for (const tx of txs) {
      if (typeof tx.idx !== 'number') {
        let num: number
        switch (tx.t) {
          case 'deposit':
            num = 0;
            break
          case 'transfer':
            num = 1;
            break;
          case 'withdraw':
            num = 2;
            break
        }
        nums.push(num)
      }
      i++
    }

    return {
      txs,
      nums,
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
