import { CID } from 'multiformats'
import { appContainer } from '../index'
import { GraphQLError } from 'graphql';

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
          const obj2 = await appContainer.self.ipfs.dag.get(CID.parse(data.state_merkle), {
            path: key,
          })
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
        } catch {
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
    const tx = await appContainer.self.transactionPool.transactionPool.findOne({
      id: args.id,
    })

    return {
      ...tx,
      // first_seen: tx.first_seen.toISOString(),
    }
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
  }
}
