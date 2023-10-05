import 'dotenv/config'
import { HiveClient } from '../utils'
import { PrivateKey } from '@hiveio/dhive'


void (async () => {
    console.log('Linking Hive identity')
    
    
    const did = process.argv[2]
    const authority_type = process.argv[3]

    if(!process.env.HIVE_ACCOUNT_POSTING || !process.env.HIVE_ACCOUNT_ACTIVE) {
        throw new Error("No HIVE account found in .env file")
    }

    const hiveAccount = process.env.HIVE_ACCOUNT


    const [accountDetails] = await HiveClient.database.getAccounts([hiveAccount])


    let json_metadata;
    try {
        json_metadata = JSON.parse(accountDetails.json_metadata)
    } catch {
        json_metadata = {}
    }

    let did_auths;

    if(json_metadata.did_auths) {
        did_auths = json_metadata.did_auths
    } else {
        did_auths = {}
    }

    did_auths[did] = {
        ats: authority_type.split(',')
    }


    const broadcast = await HiveClient.broadcast.updateAccount({
        account: hiveAccount,
        memo_key: accountDetails.memo_key,
        json_metadata: JSON.stringify({
            ...json_metadata,
            did_auths
        })
    }, PrivateKey.from(process.env.HIVE_ACCOUNT_ACTIVE))
    console.log(broadcast)
})()