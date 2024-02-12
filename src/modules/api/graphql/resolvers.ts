import { CID } from 'multiformats'
import { appContainer } from '../index'
import { GraphQLError } from 'graphql';
import * as IPFS from 'kubo-rpc-client'
import sift from 'sift'
import DAGCbor from 'ipld-dag-cbor'
import {convertTxJws} from '@vsc.eco/client/dist/utils'
import Ajv from "ajv"
import { TransactionDbStatus, TransactionDbType } from '../../../types';
import { computeKeyId, verifyTx } from '../../../services/new/utils';
import { TransactionContainerV2 } from '../../../services/new/types';

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



export const DebugResolvers = { 
  peers: async (_, args) => {

  },
  openChannels: async (_, args) => {
    
  }
}

// called recursively, as the object might consist of a nested JWS structure 
const getDagCborIpfsHashContent = async (cid: CID) => {
  let content = await appContainer.self.ipfs.dag.get(cid) as any;

  if (typeof content === 'object' && content) {
    // check if ipfs object is in JWS format, if so we need to go one layer below
    const data = content.value;
    if ('payload' in data && 'signatures' in data) {
      const nestedCid: CID = (data as any).link as CID;
      if (nestedCid.toString() === cid.toString()) {
        return 'the ipfs object is in JWS format, but the link points to itself, this is not allowed!';
      }

      content = await getDagCborIpfsHashContent(nestedCid);
      if (typeof content === 'object') {
        content.link = data.link.toString()
        content.payload = data.payload
        content.signatures = data.signatures
      } else {
        content = {
          data: content,
          link: data.link.toString(),
          payload: data.payload,
          signatures: data.signatures
        }
      }
    }
  }

  return content;
}

export const Resolvers = {
  contractState: async (_, args) => {
    const data = await appContainer.self.contractEngine.contractDb.findOne({
      id: args.id,
    })

    if(!data) {
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
          if(obj2.value.Links) {
            return obj2.value.Links.map(e => {
              return {
                ...e,
                Hash: e.Hash.toString()
              }
            })
          } else {
            return []
          }
        } catch(ex) {
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
          if(obj2.value.Links) {
            const out = await Promise.all(obj2.value.Links/*.map(e => {
              return e.Hash
            })*/.map(async (e) => {
              return {
                ...(await appContainer.self.ipfs.dag.get(e.Hash)).value,
                _id: e.Name
              }
            }));

            // console.log(out, args.query)
            if(args.query) {
              return out.filter(sift(args.query))
            } else {
              return out
            }
          } else {
            return []
          }
        } catch(ex) {
          console.log(ex)
          return null;
        }
      },
      state: async (args) => {
        try {
          let key = args.key ? `${args.key}` : null
          
          const obj = await appContainer.self.ipfs.dag.resolve(data.state_merkle, {
            path: key,
          })
          const out = await appContainer.self.ipfs.dag.get(obj.cid)
          console.log(out)

          
          if(key === null) {
            let recursiveOutput = {}
            for(let key of out.value.Links) {
              const dagVal = await appContainer.self.ipfs.dag.get(key.Hash)
              recursiveOutput[key.Name] = dagVal.value
            }
            return recursiveOutput;
          }

          return out.value
        } catch {
          return null;
        }
      },
    }
  },
  findDeposit: async (_, args) => {
    const tx = await appContainer.self.chainBridge.balanceDb.findOne({
      id: args.id,
    })

    return {
      ...tx,
    }
  },
  findTransaction: async (_, args) => {
    let query = {}

    if(args.filterOptions?.byId) {
      query['id'] = args.filterOptions.byId
    }

    if(args.filterOptions?.byStatus) {
      query['status'] = args.filterOptions.byStatus
    }

    if(args.filterOptions?.byContract) {
      query['headers.contract_id'] = args.filterOptions.byContract
    }

    if(args.filterOptions?.byAccount) {
      query['account_auth'] = args.filterOptions.byAccount
    }
    
    if(args.filterOptions?.byOpCategory) {
      query['decoded_tx.op_cateogry'] = args.filterOptions.byOpCategory
    }

    if(args.filterOptions?.byAction) {
      query['decoded_tx.action'] = args.filterOptions.byAction
    }


    const txs = await appContainer.self.transactionPool.transactionPool.find({
      ...query
    }, {
      limit: 100,
      skip: 0
    }).toArray()

    return {
      txs: txs.map(e => {
        let type;
        if(TransactionDbType.input === e.type) {
          type = 'INPUT'
        } else if(TransactionDbType.output === e.type) {
          type = 'OUTPUT'
        } else {
          type = 'NULL'
        }
        
        return {
          ...e,
          first_seen: e.first_seen.toISOString(),
          type: type
        }
      })
    }
  },
  findLedgerTXs: async (_, args) => {
    let query = {}

    if(args.byContractId) {
      query['headers.contract_id'] = args.byContractId
    }

    if(args.byToFrom) {
      query['$or'] = [
        {
          'decoded_tx.from': args.byToFrom
        },
        {
          'decoded_tx.dest': args.byToFrom
        }
      ]
    }


    let txs = await appContainer.self.transactionPool.transactionPool.find({
      ...query
    }, {
      limit: 100,
      skip: 0,
      sort: {
        first_seen: -1
      }
    }).toArray()

    const dedup = {}
    const out = []
    txs.forEach(e => {
      if((e as any).decoded_tx.tx_id) {
        if(!dedup[(e as any).decoded_tx.tx_id] || (e as any).decoded_tx.op_cateogry === 'ledger_transfer') {
          out.push(e)
          dedup[(e as any).decoded_tx.tx_id] = true
        }
      } else {
        out.push(e)
      }
    })


    return {
      txs: out.map(e => {
        return {
          ...e,
          first_seen: e.first_seen.toISOString(),
          redeem: async () => {
            if((e as any).decoded_tx.op_cateogry !== "wrap_redeem") {
              return null
            }
            const contractInfo = await appContainer.self.contractEngine.contractDb.findOne({
              id: e.headers.contract_id
            })
            console.log(contractInfo)
            try {
              
              const redeemId = (e as any).decoded_tx.redeem_id
              
              const redeemCid = await appContainer.self.ipfs.dag.resolve(IPFS.CID.parse(contractInfo.state_merkle), {
                path: `redeems/${redeemId}`,
              })
              
              return (await appContainer.self.ipfs.dag.get(redeemCid.cid)).value
            } catch (ex) {
              if (!ex.message.includes('no link named')) {
                console.log(ex)
              }
              // console.log(ex)
              return null
            }
          },
        }
      })
    };
  },
  localNodeInfo: async () => {
    const idInfo = await appContainer.self.ipfs.id()
    return {
      peer_id: idInfo.id
    }
  },
  witnessNodes: async () => {
    return await appContainer.self.witness.witnessNodes()
  },
  nextWitnessSlot: async (_, args) => {
    let node_id
    if(args.local) {
      node_id = appContainer.self.identity.id;
    } 

    const nextSlot = appContainer.self.witness.witnessSchedule.find(e => {
      if(node_id) {
        return e.in_past === false && e.did === node_id;
      } else {
        return e.in_past === false;
      }
    })
    return nextSlot;
  },

  // finds and tags vsc-tx/ vsc-blocks via ipfs CID's, unidentifiable CID's are tagged with the type 'null'
  findCID: async (_, args) => {
    if (appContainer.self.config.get('ipfs.pinEverything')) {
      const ipfsHash = args.id;
  
      let cid = null;
      try {
        cid = CID.parse(ipfsHash)
      } catch {
        throw new GraphQLError('Invalid CID format!')
      }

      // get ipfs content for cid
      let content = null;
      if (cid.code === 0x70) {
        // dag-pd
        const stream = appContainer.self.ipfs.cat(cid);
        const chunks = [];

        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);
        let dataRaw = buffer.toString(); 

        try {
          content = JSON.parse(dataRaw);
        } catch (e) {
          content = dataRaw;
        }
      } else if (cid.code === 0x71) {
        // dag-cbor
        content = await getDagCborIpfsHashContent(cid);
      }
  
      // determine the type of vsc data structure that was found e.g.: vsc-tx/ blocks
      let type = null;
      if (content && typeof content.value === 'object' && content.value.__t && ['vsc-tx', 'vsc-block'].includes(content.value.__t)) {
        type = content.value.__t
      }

      let result: {
        type: string,
        data: any,
        link?: string,
        payload?: string,
        signatures?: {
          protected: string,
          signature: string
        }[]
      } = { type: type, data: content.value }
      if (content.payload && content.signatures && content.link) {
        result.payload = content.payload
        result.signatures = content.signatures
        result.link = content.link
      }
      return result
    } else {
      throw new GraphQLError("Current node configuration does not allow for this endpoint to be used.")
    }
  },
  submitTransaction: async (_, args) => {
    console.log(args.payload)
    const json = JSON.parse(args.payload)


    if(json.jws && json.linkedBlock) {
      const root = await appContainer.self.ipfs.dag.put({
        ...json.jws,
        link: CID.parse(json.jws['link'].toString()) //Glich with dag.put not allowing CIDs to link
      })

      const linkedBlock = await appContainer.self.ipfs.block.put(Buffer.from(json.linkedBlock, 'base64'), {
        format: 'dag-cbor'
      })
      console.log('graphql:linkedBlock', linkedBlock)

      await appContainer.self.transactionPool.processMempoolTX(root.toString())

      await appContainer.self.transactionPool.txDecode(root.toString(), await appContainer.self.transactionPool.transactionPool.findOne({
        id: root.toString()
      }))

      await appContainer.self.p2pService.memoryPoolChannel.call('announce_tx', {
        payload: {
          id: root.toString()
        },
        mode: 'basic'
      })

      return {
        tx_id: root.toString()
      }
    }
  },
  submitTransactionV1: async (_, args) => {
    const {id} = await appContainer.self.newService.transactionPool.ingestTx({
      tx: args.tx,
      sig: args.sig
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
    if(nonceData) {
      nonce = nonceData.nonce
    } else {
      nonce = 0;
    }
    return {
      nonce
    }
  }
}
