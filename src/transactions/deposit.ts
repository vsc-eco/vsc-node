import {init} from './core'
import { TransactionPoolService } from '../services/transactionPool';

void (async () => {
    // sample usage
    // <amount>
    // <amount> [<contractId>]
    // <amount> [<contractId>] [<to>]
    // <amount> [<to>]
    // the parameter 'contractId' and 'to' need to be supplied in the following syntax
    // --contract_id=
    // --to=
    // contract_id = target contract where the funds should be deposited
    // to = target account which is credited with the funds
    // when no 'to' parameter is supplied, the funds are deposited to the account that publishes the transaction
    // node --experimental-specifier-resolution=node --loader ts-node/esm src/transactions/deposit.ts 15 --contract_id=351d68f85ab150c71e577ae4ab406eacb6fb4b2a --to=sudokurious

    const setup: {identity, config, ipfsClient, logger} = await init()
        
    let contractId;
    let contractIdArg  = process.argv.find(arg => arg.startsWith('--contract_id='))
    if (contractIdArg) {
        contractId = contractIdArg.split('=')[1]
    }

    let to;
    let toArg  = process.argv.find(arg => arg.startsWith('--to='))
    if (toArg) {
        to = toArg.split('=')[1]
    }

    await TransactionPoolService.deposit({
        contractId: contractId,
        amount: +process.argv[3],
        to: to
    },
    setup);

    process.exit(0)
})()