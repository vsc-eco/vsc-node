import {init} from './core'
import {HiveClient} from '../utils'
import { PrivateKey } from '@hiveio/dhive'
import { JoinContract } from '../types/transactions.js'
import Axios from 'axios'
import { TransactionPoolService } from '../services/transactionPool'

void (async () => {
    
    const contract_id = process.argv[2]
    const action = process.argv[3]
    const payload = process.argv[4]

    // sample usage
    // npx ts-node-dev src/transactions/callContract.ts 351d68f85ab150c71e577ae4ab406eacb6fb4b2a set "{...payload}"
    if(!contract_id || !action || !payload) {
        console.log('Usage: callContract.ts <contract id> <action> <payload>')
        process.exit(0)
    }

    // push message to node
    // node should publish this tx to pubsub 
    // *all the nodes* should create the multisig 
    // the *selected* node should combine the multisigs and
    // create a block and do the announce block
    // this callContract is different from the other ones as it just 
    // publishes the tx to a node instead of a hive TX
    // in the real scenario the client would interact with a node api 
    // and the node would publish the tx to pubsub, i think it makes sense here
    // to just skip that for now and act like the node publishes the tx directly to pubsub
    
    const setup: {identity, config, ipfsClient} = await init()

    await TransactionPoolService.callContract(contract_id, action, payload, setup);
    
    process.exit(0)
})()