import { PrivateKey } from '@hiveio/dhive'
import Axios from 'axios'
import {init} from './core'
import {HiveClient} from '../utils'
import { EnableWitness } from '../types/transactions'
import { TransactionPoolService } from '@/services/transactionPool'

void (async () => {
    const setup: {identity, config, ipfsClient} = await init()
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

    const json: EnableWitness = {
        action: "enable_witness",
        net_id: setup.config.get('network.id'),
        did: setup.identity.id,
        node_id: nodeInfo.peer_id
    }

    const result = TransactionPoolService.createCoreTransaction("vsc.enable_witness", json, setup)
    console.log(result)

    process.exit(0)
})()