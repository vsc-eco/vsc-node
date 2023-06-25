import {init} from './core'
import {HiveClient} from '../utils'
import { PrivateKey } from '@hiveio/dhive'
import Axios from 'axios'
import { TransactionPoolService } from '../services/transactionPool'
import { CoreService } from '../services/index'
import { getLogger } from '../logger'

void (async () => {
    const contract_id = process.argv[2]
    const action = process.argv[3]
    const payload = process.argv[4]

    const core = new CoreService({}, {
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
      })

    // sample usage
    // node --experimental-specifier-resolution=node --loader ts-node/esm src/transactions/callContract.ts <contract_id> <contract_method> <parameters>
    // node --experimental-specifier-resolution=node --loader ts-node/esm src/transactions/callContract.ts 5b656c5eab07e7cbb954c8db7c359c0b5e0da2d4 set "{\"key\":\"Hello\", \"value\":\"world\"}"
    if(!contract_id || !action || !payload) {
        core.logger.error('Usage: callContract.ts <contract id> <action> <payload>')
        process.exit(0)
    }

    const payloadJson = JSON.parse(payload)

    
    await core.start()

    const transactionPool = new TransactionPoolService(core)

    await transactionPool.start()

    const result = await transactionPool.callContract(contract_id, {
        action,
        payload: payloadJson
    });
    core.logger.debug('result of contract invokation' , result)
    
    process.exit(0)
})()