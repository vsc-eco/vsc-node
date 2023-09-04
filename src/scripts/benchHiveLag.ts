import { Client, PrivateKey } from "@hiveio/dhive"
import 'dotenv/config'

 
const HIVE_APIS = [
    'api.shmoogleosukami.co.uk',
    "hive-api.3speak.tv",
    "api.hive.blog",
    "api.openhive.network",
    "anyx.io",
    "hived.privex.io",
    "rpc.ausbit.dev",
    "techcoderx.com",
    "hived.emre.sh",
    "api.deathwing.me",
    "api.c0ff33a.uk"
]

void (async () => {
    let results = {

    }


    for(let api of HIVE_APIS) {
        let transaction_id;
        let broadcastTime;
        const HiveClient = new Client(`https://${api}`)
        const promise = (async () => {
            try {
                for await (let block of HiveClient.blockchain.getBlockStream()) {
                    if((block as any).transaction_ids.includes(transaction_id)) {
                        console.log('Test Complete!', new Date(), broadcastTime, new Date().getTime() - broadcastTime.getTime())
                        results[api] = {
                            lag: new Date().getTime() - broadcastTime.getTime()
                        }
                        break;
                    }
                }
            } catch(ex) {
                console.log(ex)
            }
        })()
        try {
            const hiveResult = await HiveClient.broadcast.json({
                required_auths: [],
                required_posting_auths: [process.env.HIVE_ACCOUNT],
                id: "test-test-test-test",
                json: JSON.stringify({}),
            }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING))
            transaction_id = hiveResult.id
            broadcastTime = new Date()
            await promise;
        } catch (ex) {

        }
    }

    
    console.log(JSON.stringify(results, null, 2))

    
    // process.exit(0)
})()