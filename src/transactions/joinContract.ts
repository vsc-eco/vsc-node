import {init} from './core.js'
import {HiveClient} from '../utils.js'
import { PrivateKey } from '@hiveio/dhive'

void (async () => {
    
    const execPath = process.argv[2]
    
    if(!execPath) {
        console.log('Usage: joinContract.ts <id of contract>')
        process.exit(0)
    }
    const {identity} = await init()
    
    // await HiveClient.broadcast.json({
    //     id: "vsc.enable_witness",
    //     required_auths: [],
    //     required_posting_auths: [process.env.HIVE_ACCOUNT!],
    //     json: JSON.stringify({

    //     })
    // }, PrivateKey.from(process.env.HIVE_ACCOUNT_POSTING!))
    
    process.exit(0)
})()