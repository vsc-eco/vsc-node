import { CID } from 'multiformats'
import { coreContainer } from '../index'

export const Resolvers = {
  contractState: async (_, args) => {
    const data = await coreContainer.self.contractEngine.contractDb.findOne({
      id: args.id,
    })

    return {
      id: data.id,
      state: async (args) => {
        const obj = await coreContainer.self.ipfs.dag.resolve(data.stateMerkle, {
          path: `${args.key}`,
        })
        const out = await coreContainer.self.ipfs.dag.get(obj.cid)
        return out.value
      },
    }
  },
  findTransaction: async (_, args) => {
    const tx = await coreContainer.self.transactionPool.transactionPool.findOne({
      id: args.id,
    })
    console.log(tx)

    return {
      ...tx,
      first_seen: tx.first_seen.toISOString(),
    }
  },
  localNodeInfo: async () => {
    const idInfo = await coreContainer.self.ipfs.id()
    return {
      peer_id: idInfo.id
    }
  }
}
