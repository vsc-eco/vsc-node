import {init} from './core'
import { TransactionPoolService } from '../services/transactionPool';
import { isExecutedDirectly } from '../utils';

export async function deposit() {
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
    // node --experimental-specifier-resolution=node --loader ts-node/esm src/transactions/deposit.ts 1

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

    return await TransactionPoolService.deposit({
        contractId: contractId,
        amount: +process.argv[process.argv.length - 1],
        to: to
    },
    setup);
}

if (isExecutedDirectly()) {
    deposit();
    process.exit(0)
}
