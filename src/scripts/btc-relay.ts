import Axios from 'axios'
import { utils, BTCUtils, ser, ValidateSPV } from '@summa-tx/bitcoin-spv-js'
import {CID} from 'kubo-rpc-client'
import { parseTxHex, reverse } from '../scripts/bitcoin-wrapper/utils'

import { BTCBlockStream } from "./bitcoin-wrapper/utils";
import { sleep } from '../utils';
import { TransactionPoolService } from '../services/transactionPool';
import { CoreService } from '../services';


async function waitTxConfirm(id: string, self: CoreService, func) {
    let lastStatus;
    for( ; ; ) {
        const {data} = await Axios.post('http://localhost:1337/api/v1/graphql', {
            query: `
            query MyQuery {
                findTransaction(id: "${id}") {
                  status
                }
              }`
        })
        console.log(data.data)
        await self.p2pService.memoryPoolChannel.call('announce_tx', {
            payload: {
              id: id.toString()
            },
            mode: 'basic'
        })
        if(func && ['CONFIRMED', 'INCLUDED'].includes(data.data.findTransaction.status) && lastStatus !== data.data.findTransaction.status) {
            func(data.data.findTransaction.status)
            lastStatus = data.data.findTransaction.status
        }
        if(data.data.findTransaction.status === "CONFIRMED") {
            return;
        }
        await sleep(5_000)
    }
}

void (async () => {
    const contract_id = '42fe0195bb2fe0afe7e015871d8c5749d07177cc'

    const core = new CoreService({
        prefix: 'manual tx core',
        printMetadata: true,
        level: 'debug',
        mode: 'lite'
    })

    await core.start()

    const transactionPool = new TransactionPoolService(core)

    await transactionPool.start()

    
    
    let x = 0;
    let topBlock = 0;
    while (topBlock < 800_000) {
        const {state_merkle} = await core.contractEngine.contractDb.findOne({
            id: contract_id
        })
        try {
            const dag = (await core.ipfs.dag.resolve(CID.parse(state_merkle), {
                path: 'pre-headers/main'
            }))
            console.log((await core.ipfs.dag.get(dag.cid)).value,  Object.entries((await core.ipfs.dag.get(dag.cid)).value).map((e) => {
                return (e[1] as any).height 
            }))
            topBlock = Object.entries((await core.ipfs.dag.get(dag.cid)).value).map((e) => {
                return (e[1] as any).height 
            }).sort((a, b) => {
                return a - b;
            })[0] || 0
            console.log('topBlock', topBlock)
        } catch (ex) {
            console.log(ex)
            topBlock = 0;
        }
        // console.log(state_merkle, topBlock)
        const abortController = new AbortController()
        let headerBulk = [] as any
        for await(let [header] of BTCBlockStream(topBlock, abortController.signal)) {
            headerBulk.push(header)
            const decodeHex = new Uint8Array(Buffer.from(header, 'hex'))
            // const prevBlock = reverse(BTCUtils.extractPrevBlockLE(decodeHex));
            x = x + 1;
            if(x >= 1500) {
                const result = await transactionPool.callContract(contract_id, {
                    action: 'processHeaders',
                    payload: {
                        headers: headerBulk
                    }
                });
                core.logger.debug('result of contract invokation' , result)
                const date = new Date();
                await waitTxConfirm(result.id, core, (state) => {
                    if(state === "INCLUDED") {
                        console.log('Included after', new Date().getTime() - date.getTime(), 's')
    
                    }
                })
                console.log('Confirmed after', new Date().getTime() - date.getTime(), 's')
                await sleep(30_000)
                headerBulk = []
                x = 0;
                break;
            }
        }
        abortController.abort()
    }
})()