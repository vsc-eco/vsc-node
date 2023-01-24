import { PrivateKey } from '@hiveio/dhive'
import Axios from 'axios'
import {init} from './core.js'
import {HiveClient} from '../utils.js'
import { EnableWitness } from '../types/transactions.js'

void (async () => {
    const {identity, config} = await init()
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
    console.log(nodeInfo)

    const transaction = await HiveClient.broadcast.json({
        id: "vsc.enable_witness",
        required_auths: [],
        required_posting_auths: [process.env.HIVE_ACCOUNT!],
        json: JSON.stringify({
            action: "enable_witness",
            net_id: config.get('network.id'),
            did: identity.id,
            node_id: nodeInfo.peer_id
        } as EnableWitness)
    }, PrivateKey.from(process.env.HIVE_ACCOUNT_POSTING!))
    console.log(transaction)

    process.exit(0)
})()