import {init} from './core'
import { TransactionPoolService } from '../services/transactionPool';

void (async () => {
    // sample usage
    // when invoked with 2 args <contract id> <amount> the deposit takes place on a contract
    // if only 1 arg <amount> is supplied, the deposit takes place on the general balance of the user
    // node --experimental-specifier-resolution=node --loader ts-node/esm src/transactions/deposit.ts 351d68f85ab150c71e577ae4ab406eacb6fb4b2a 15

    const setup: {identity, config, ipfsClient, logger} = await init()
                
    if (process.argv.length == 4) {
        await TransactionPoolService.deposit({
            amount: +process.argv[2]
        },
        setup);
    } else if (process.argv.length == 5) {
        await TransactionPoolService.deposit({
            contractId: process.argv[2],
            amount: +process.argv[3]
        },
        setup);
    } else {    
        setup.logger.info('Usage: deposit.ts [<contract id>] <amount>')
        process.exit(0)        
    }

    process.exit(0)
})()