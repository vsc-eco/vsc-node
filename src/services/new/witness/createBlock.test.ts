import { createIPFSClient, createMongoDBClient } from "@/utils"
import { WitnessServiceV2 } from "."
import { NewCoreService } from ".."
import { TransactionDbRecordV2 } from "../types"
import { ContractEngineV2 } from "../contractEngineV2"
import { mongo } from "@/services/db"
import { txs } from "@/vsc-new.transaction_pool-part"
import { txsFull } from "@/vsc-new.transaction_pool-full"
import { shuffle } from "./schedule"

const mock = <T extends object>(name: string, handler: ProxyHandler<T>) => new Proxy({} as T, new Proxy(handler, {
        get(target, method, receiver) {
            const errorFn = (_: any, prop: string | symbol) => {
                throw new Error(`${String(method)}ing ${name}.${String(prop)} is not mocked yet`)
            }
            if (method in target) {
                return Reflect.get(target, method, errorFn);
            }
            return errorFn
        },
    }))

describe('createBlock', () => {
    // suppress all console.log's for now
    const log = console.log.bind(console);
    console.log = () => {}

    // mocks
    const db = createMongoDBClient('new')
    const ipfs = createIPFSClient({url: 'http://127.0.0.1:5101'})
    const core: NewCoreService = mock('core', {
        get(target, p, receiver) {
            switch(p) {
                case 'ipfs':
                    return ipfs;
                case 'transactionPool':
                    return mock('transactionPool', {
                        get(target, p, receiver) {
                            if (p === 'txDb') {
                                return db.collection('transaction_pool')
                            }
                            throw new Error('hmm2')
                        },
                    });
                case 'nonceMap':
                    return db.collection('nonce_map');
                case 'contractEngine':
                    return contractEngine;
                case 'db':
                    return db;
                case 'chainBridge':
                    return mock('chainBridge', {
                        get(target, p, receiver) {
                            switch (p) {
                                case 'streamParser':
                                    return mock('streamParser', {
                                        get(target, p, receiver) {
                                            switch (p) {
                                                case 'addParser':
                                                    return () => {}
                                            }
                                        },
                                    })
                                case 'blockHeaders':
                                    return db.collection('block_headers');
                            }
                        },
                    })
            }
            throw new Error('hmm')
        },
    })
    const contractEngine = new ContractEngineV2(core)

    beforeAll(async () => {
        await mongo.connect();
        await contractEngine.init();
    })

    afterAll(async () => {
        await mongo.close()
        setTimeout(() => process.exit(0), 1000)
    })

    // service to test
    let witness: WitnessServiceV2
    beforeEach(async () => {
        witness = new WitnessServiceV2(core)
        witness.blockHeaders = db.collection('block_headers')
    })

    const testCases: { inputName: string; txs: TransactionDbRecordV2[] }[] = [
        {
            inputName: 'no input',
            txs: []
        },
        {
            inputName: 'many contract calls',
            // @ts-ignore
            txs,
        },
        {
            inputName: 'very many contract calls',
            // @ts-ignore
            txs: txsFull,
        }
    ]

    for (const {inputName, txs} of testCases) {

        it(`should create consistent output for the same input with ${inputName}`, async () => {
            const createBlock = () => witness.createBlock({
                start_height: 86407310 + 1,
                end_height: 86424500,
                offchainTxsUnfiltered: txs
            })

            const [b1, b2] = await Promise.all([createBlock(), createBlock()])

            expect(b1).toStrictEqual(b2)
            expect(b1.rawData.txs.length - txs.length).toMatchSnapshot()
            expect(b1).toMatchSnapshot()
        })

        it(`should create differ output for the same but jumbled input with ${inputName}`, async () => {
            let count = 0;
            const createBlock = () => witness.createBlock({
                start_height: 86407310 + 1,
                end_height: 86424500,
                offchainTxsUnfiltered: shuffle(txs, (++count).toString())
            })

            const [b1, b2] = await Promise.all([createBlock(), createBlock()])

            if (txs.length === 0) { 
                expect(b1).toStrictEqual(b2)
            } else {
                expect(b1).not.toStrictEqual(b2)
            }
            expect(b1.rawData.txs.length - txs.length).toMatchSnapshot()
            expect(b2.rawData.txs.length - txs.length).toMatchSnapshot()
            expect(b1).toMatchSnapshot()
            expect(b2).toMatchSnapshot()
        })

    }
})