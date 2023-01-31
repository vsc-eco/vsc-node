import {init} from './core'
import {HiveClient} from '../utils'
import { PrivateKey } from '@hiveio/dhive'
import { CreateContract } from '../types/transactions.js'
import * as fs from 'fs';
import * as vm from 'vm';

void (async () => {
    
    const name = process.argv[2]
    const execPath = process.argv[3]

    // sample usage
    // npx ts-node-dev src/transactions/createContract.ts testname src/services/contracts/basic-contract.js
    
    if(!execPath) {
        console.log('Usage: createContract.ts <name of contract> <path to contract>')
        process.exit(0)
    }
    const {identity, config} = await init()

    let code = ""
    try {
        const data = fs.readFileSync(execPath, 'utf8');
        //console.log(data);
        code = data
    } catch (err) {
        console.error('not able to load contract file:\n', err);
        process.exit(0)
    }

    try {
        new vm.Script(code);
    } catch (err) {
        console.error('provided script is invalid:\n', err);
        process.exit(0)
    }

    // pla: create manifest here, also prompt the user for more data (the stuff required for the manifest)
    // upload it to ipfs
    // take the cid of the upload as id for the contract creation/ contract

    await HiveClient.broadcast.json({
        id: "vsc.create_contract",
        required_auths: [],
        required_posting_auths: [process.env.HIVE_ACCOUNT!],
        json: JSON.stringify({
            manifest_id: '', // CID OF MANIFEST HERE
            action: 'create_contract',
            name: name,
            code: code,
            net_id: config.get('network.id')
        } as CreateContract)
    }, PrivateKey.from(process.env.HIVE_ACCOUNT_POSTING!))
    
    process.exit(0)
})()