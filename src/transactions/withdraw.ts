

import {init} from './core'
import { TransactionPoolService } from '../services/transactionPool';

void (async () => {
    // sample usage
    // if 1 arg <amount> is supplied, the withdraw takes place on the general balance of the user
    // contrary to the deposit on a contract, the withdraw method needs to be implemented in the code of the contract as after funds have been transfered to the contract, the contract is responsible for managing them
    // node --experimental-specifier-resolution=node --loader ts-node/esm src/transactions/withdraw.ts 0.13

    const setup: {identity, config, ipfsClient, logger} = await init()

    await TransactionPoolService.withdraw({
        amount: +process.argv[2]
    },
    setup);

    process.exit(0)
})()