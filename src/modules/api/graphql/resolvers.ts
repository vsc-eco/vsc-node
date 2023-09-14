import { CID } from 'multiformats'
import { appContainer } from '../index'

export const DebugResolvers = { 
  peers: async (_, args) => {

  },
  openChannels: async (_, args) => {
    
  }
}

function tryJSONParse(str): string {
  try {
      return JSON.parse(str);
  } catch (e) {
      return str;
  }
}

const getRelevantContentOfIpfsHash = async (ipfsHash: string) => {
  let content = await appContainer.self.ipfs.dag.get(CID.parse(ipfsHash)) as any;

  // determine if ipfs hash resembles a regular ipfs object and not an ipfs cbor object 
  if ('Links' in content.value && 'Data' in content.value) {

    const stream = appContainer.self.ipfs.cat(CID.parse(ipfsHash));
    const chunks = [];

    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    let dataRaw = buffer.toString(); 

    content = tryJSONParse(dataRaw);
  } else {
    content = content.value
  }

  if (typeof content === 'object') {
    // check if ipfs object is in JWS format, if so we need to go one layer below
    if ('payload' in content && 'signatures' in content) {
      content = getRelevantContentOfIpfsHash(((content as any).link as CID).toString())
      content = tryJSONParse(content);
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
  
      if (!ipfsHash) {
        return null;
      }
  
      if (ipfsHash.startsWith('Qm') || ipfsHash.startsWith('bafy')) {
        const content = await getRelevantContentOfIpfsHash(ipfsHash);
        let type = null;
        
        // detects vsc-tx/ blocks
        if (typeof content === 'object' && '__t' in content && ['vsc-tx', 'vsc-block'].includes(content.__t)) {
          type = content.__t
        }

        return { type: type, data: content }
      } else {
        return { type: "error", data: "CID format not supported!" }
      }
    } else {
      return { type: "error", data: "Current node configuration does not allow for this endpoint to be used." }
    }
  }
}
