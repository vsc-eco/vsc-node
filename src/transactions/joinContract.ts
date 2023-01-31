import {init} from './core'
import {HiveClient} from '../utils'
import { PrivateKey } from '@hiveio/dhive'
import { JoinContract } from '../types/transactions.js'
import Axios from 'axios'

void (async () => {
    
    const contract_id = process.argv[2]

    // sample usage
    // npx ts-node-dev src/transactions/joinContract.ts 351d68f85ab150c71e577ae4ab406eacb6fb4b2a
    
    if(!contract_id) {
        console.log('Usage: joinContract.ts <contract id>')
        process.exit(0)
    }
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
    
    await HiveClient.broadcast.json({
        id: "vsc.join_contract",
        required_auths: [],
        required_posting_auths: [process.env.HIVE_ACCOUNT!],
        json: JSON.stringify({
            action: 'join_contract',
            contract_id: contract_id,
            node_id: nodeInfo.peer_id,
            net_id: config.get('network.id')
        } as JoinContract)
    }, PrivateKey.from(process.env.HIVE_ACCOUNT_POSTING!))
    
    process.exit(0)
})()