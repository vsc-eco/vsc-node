import {init} from './core'
import {HiveClient} from '../utils'
import { PrivateKey } from '@hiveio/dhive'
import { CreateContract } from '../types/transactions'
import * as fs from 'fs';
import * as vm from 'vm';
import { TransactionPoolService } from '../services/transactionPool';

void (async () => {
    
    const name = process.argv[2]
    const description = process.argv[3]
    const execPath = process.argv[4]

    // sample usage
    // npx ts-node-dev src/transactions/createContract.ts testname "test description" src/services/contracts/basic-contract.js
    
    if(!execPath) {
        console.log('Usage: createContract.ts <name of contract> <description of contract e.g.: "..."> <path to contract>')
        process.exit(0)
    }
    const setup: {identity, config, ipfsClient} = await init()

    let code = ""
    try {
        const data = fs.readFileSync(execPath, 'utf8');
        //console.log(data);
        code = data
    } catch (err) {
        console.error('not able to load contract file:\n', err);
        process.exit(0)
    }

    await TransactionPoolService.createContract({
            name: name,
            code: code,
            description: description
        },
        setup);
    
    process.exit(0)
})()