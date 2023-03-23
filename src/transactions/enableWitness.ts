import { PrivateKey } from '@hiveio/dhive'
import Axios from 'axios'
import {init} from './core'
import {HiveClient} from '../utils'
import { EnableWitness } from '../types/transactions'
import { TransactionPoolService } from '../services/transactionPool'

void (async () => {
    const setup: {identity, config, ipfsClient, logger} = await init()
    await TransactionPoolService.enableWitness(setup);
    process.exit(0)
})()