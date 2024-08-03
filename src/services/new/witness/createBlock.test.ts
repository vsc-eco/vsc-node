import 'dotenv/config'
import { createIPFSClient, createMongoDBClient } from "@/utils"
import { TxContext, WitnessServiceV2 } from "."
import { NewCoreService } from ".."
import { TransactionDbRecordV2, TransactionDbStatus, TransactionDbType } from "../types"
import { ContractEngineV2 } from "../contractEngineV2"
import { mongo } from "@/services/db"
import { txs } from "@/vsc-new.transaction_pool-part"
import { txsFull } from "@/vsc-new.transaction_pool-full"
import { shuffle } from "./schedule"
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from "mongodb"
import assert from "assert"


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

let mongod: MongoMemoryServer
let client: MongoClient
beforeAll(async () => {
    mongod = await MongoMemoryServer.create();

    const uri = mongod.getUri();
    
    client = new MongoClient(uri)
})

afterAll(async () => {
    await mongod.stop()
})

describe('createBlock', () => {
    // suppress all console.log's for now
    const log = console.log.bind(console);
    console.log = () => {}




    // mocks
    const db = createMongoDBClient('new')
    const ipfs = createIPFSClient({url: process.env.IPFS_HOST || 'http://127.0.0.1:5101'})
    let realTxData = true
    const core: NewCoreService = mock('core', {
        get(target, p, receiver) {
            switch(p) {
                case 'ipfs':
                    return ipfs;
                case 'transactionPool':
                    return mock('transactionPool', {
                        get(target, p, receiver) {
                            if (p === 'txDb') {
                                if (realTxData) {
                                    return db.collection('transaction_pool')
                                }
                                return client.db('vsc-new').collection('transaction_pool')
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
    const contractEngine = new ContractEngineV2(core);

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
        witness.balanceKeeper.balanceDb = db.collection('bridge_balances')
        witness.balanceKeeper.ledgerDb = db.collection('bridge_ledger')
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

    describe('balanceSystem', () => {
        beforeAll(() => {
            realTxData = false
            witness.balanceKeeper.balanceDb = client.db('vsc-new').collection('balances')
            witness.balanceKeeper.ledgerDb = client.db('vsc-new').collection('ledger')
        })
        // beforeEach(async () => {})
        afterEach(async () => {
            await core.transactionPool.txDb.deleteMany({})
        })

        it('transfer event', async () => {
            const demoTransactions = [ 
                {
                    status: TransactionDbStatus.included,
                    id: '#tx.test-1',
          
                    required_auths: [
                      {
                        type: 'active' as any,
                        value: 'hive:vaultec'
                      }
                    ],
                    headers: {
                      type: TransactionDbType.core,
                    },
                    data: {
                      op: "transfer",
                      payload: {
                        to: 'hive:geo52rey',
                        from: 'hive:vaultec',
                        amount: 1500,
                        memo: "What's up!",
                        tk: 'HBD'
                      }
                    },
                    local: false,
                    accessible: true,
                    first_seen: new Date(),
                    src: 'hive'  as any,
                    anchored_id: 'bafyreih3heoeeagnyw7op6jfr7amr4jdiu32dezipr32ytekvmndzhuxgu',
                    anchored_block: 'test',
                    anchored_height: 81614001,
                    anchored_index: 0,
                    anchored_op_index: 0,
                },
                {
                    status: TransactionDbStatus.included,
                    id: '#tx.test-2',
            
                    required_auths: [
                        {
                        type: 'active'  as any,
                        value: 'hive:vaultec'
                        }
                    ],
                    headers: {
                        type: TransactionDbType.core,
                    },
                    data: {
                        op: "withdraw",
                        payload: {
                        to: 'hive:geo52rey',
                        from: 'hive:geo52rey',
                        amount: 500,
                        tk: 'HBD'
                        }
                    },
                    local: false,
                    accessible: true,
                    first_seen: new Date(),
                    src: 'hive'  as any,
                    anchored_id: 'bafyreih3heoeeagnyw7op6jfr7amr4jdiu32dezipr32ytekvmndzhuxgu',
                    anchored_block: 'test',
                    anchored_height: 81614001,
                    anchored_index: 1,
                    anchored_op_index: 0,
                },
                {
                    status: TransactionDbStatus.included,
                    id: '#tx.test-3',
                    
                    required_auths: [
                        {
                        type: 'active'  as any,
                        value: 'hive:vaultec'
                        }
                    ],
                    headers: {
                        type: TransactionDbType.input,
                        intents: [
                        "hive.allow_transfer?limit=1500&token=hbd"
                        ]
                    },
                    data: {
                        op: "call_contract",
                        contract_id: "vs41q9c3ygxjdas756pxjj0x82c6a8tttrvr4kxdnkdgvyjwfuwslphdwsgfjg2f7tc3",
                        action: "pullBalance",
                        payload: {
                        from: "hive:geo52rey",
                        amount: 500,
                        asset: 'HBD'
                        }
                    },
                    local: false,
                    accessible: true,
                    first_seen: new Date(),
                    src: 'hive'  as any,
                    anchored_id: 'bafyreih3heoeeagnyw7op6jfr7amr4jdiu32dezipr32ytekvmndzhuxgu',
                    anchored_block: 'test',
                    anchored_height: 81614001,
                    anchored_index: 2,
                    anchored_op_index: 0,
                },
            ]
            await core.transactionPool.txDb.insertMany(demoTransactions as any)

            const block = await witness.createBlock({
                start_height: 81614001,
                end_height: 81614001,
                offchainTxsUnfiltered: []
            })

            const contractIds = demoTransactions.filter(e => e.data.op === 'call_contract').map(e => e.data.contract_id)
            const txContext = new TxContext({
                br: [81614000, 81614010],
                contractIds: [
                '#virtual.test.pull',
                    ...contractIds
                ],
                mockBalance: {
                    'hive:vaultec': {
                        HBD: 3_000,
                        HIVE: 0,
                    }
                },
            }, witness.balanceKeeper, contractEngine)
        
            await txContext.init()
            
            
            for(let tx of demoTransactions) {
                const txResult = await txContext.executeTx(tx)
                console.log('txResult', txResult)
            }

            const finalizedResult = await txContext.finalize(core.ipfs)

            console.log('finalizedResult', finalizedResult)
            assert('object', typeof finalizedResult)
            expect(finalizedResult).toMatchSnapshot()
        })
    })
})