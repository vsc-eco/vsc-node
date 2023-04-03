import { CID } from 'multiformats'
import { appContainer } from '../index'

export const Resolvers = {
  contractState: async (_, args) => {
    const data = await appContainer.self.contractEngine.contractDb.findOne({
      id: args.id,
    })

    return {
      id: data.id,
      state_merkle: data.state_merkle,
      state: async (args) => {
        try {
          const obj = await appContainer.self.ipfs.dag.resolve(data.state_merkle, {
            path: `${args.key}`,
          })
          const out = await appContainer.self.ipfs.dag.get(obj.cid)
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
  }
}
