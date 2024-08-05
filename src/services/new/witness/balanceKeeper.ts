import {Transaction} from '@hiveio/dhive'
import { NewCoreService } from '..';
import { Collection } from 'mongodb';
import * as HiveTx from 'hive-tx';
import hive from '@hiveio/hive-js';
import { CID } from 'kubo-rpc-client'
import networks from '../../../services/networks';
import { HiveClient, HiveClient2, makeSimpleObjectText } from '../../../utils';
import moment from 'moment';
import eip55 from 'eip55';
import { EventOp, EventOpType  } from '../vm/types';
import { TransactionDbRecordV2, TransactionDbStatus, TransactionDbType } from '../types';
import { ParserFuncArgs } from '../utils';
const PrivateKey = HiveTx.PrivateKey;

interface TxReceipt {
    status: "PENDING" | "COMPLETE"
    amount: Number
    unit: "HIVE" | "HBD"
    to: string
    
}

interface DepositTx {
    //Default as deposit to self if no memo is specified
    action: "DEPOSIT"
    dest: '#self' | '#contract'
    addr?: string
    op?: Object

}

interface BalanceType {
    account: string
    tokens: {
        HIVE: number
        HBD: number
    }
    block_height: number
}



/**
 * Manages multisig balances, deposits, and withdrawals
 */
export class BalanceKeeper {
    self: NewCoreService;
    balanceDb: Collection<BalanceType>
    withdrawDb: Collection<{
        id: string
        amount: number
        block_height: number
        dest: string
        height: number
        idx: number
        status: 'PENDING' | 'COMPLETE'
        t:"withdraw"
        tk: "HIVE" | "HBD"
    }>;
    ledgerDb: Collection<{
        id: string
        dest: string
        amount: number
        tk: "HIVE" | "HBD"
        height: number
        idx: number
        memo?: string
        t: 'deposit' | 'transfer' | 'withdraw'

        //Receip
        receipt_id?: string
    }>;
    constructor(self: NewCoreService) {
        this.self = self;

        this.getSnapshot = this.getSnapshot.bind(this)
    }

    get multisigAccount () {
        return networks[this.self.config.get('network.id')].multisigAccount
    }


    /**
     * Gets historical balance of an account or current upon requesting recent block height
     * @param account
     * @param block_height 
     */
    async getOwnershipAt(account: string, block_height: number) {

    }

    async getSnapshot(account: string, block_height: number) { 
        const lastBalance = await this.balanceDb.findOne({account})

        const balanceTemplate = lastBalance ? {
            account: account,
            tokens: {
                HIVE: lastBalance.tokens.HIVE,
                HBD: lastBalance.tokens.HBD
            },
            block_height: block_height
        } : {
            account: account,
            tokens: {
                HIVE: 0,
                HBD: 0
            },
            block_height: block_height
        }

        const hiveDeposits = await this.ledgerDb.find({
            tk: 'HIVE',
            owner: account,
            block_height: {
                $lte: block_height
            }
        }, {
            sort: {
                block_height: 1
            }
        }).toArray()
        const hbdDeposits = await this.ledgerDb.find({
            tk: 'HBD',
            owner: account,
            block_height: {
                $lte: block_height
            }
        }, {
            sort: {
                block_height: 1
            }
        }).toArray()

        const hiveAmount = hiveDeposits.map(e => e.amount).reduce((acc, cur) => { 
            return acc + cur
        }, balanceTemplate.tokens.HIVE)

        const hbdAmount = hbdDeposits.map(e => e.amount).reduce((acc, cur) => { 
            return acc + cur
        }, balanceTemplate.tokens.HBD)


        return {
            account: account,
            tokens: {
                HIVE: hiveAmount,
                HBD: hbdAmount
            },
            block_height: block_height
        };
    }

    async processEvents(blockEvents: 
        {
            __t: 'vsc-events',
            txs: Array<string>
            txs_map: Array<Array<number>>
            events: Array<EventOp>
        }, blockInfo: {
            blockId: string
            blockHeight: number
        }
    ) {
        const {blockHeight, blockId} = blockInfo
        //List of accounts whos balances have changed
        const balancesUpdated = {}

        console.log('blockEvents', blockEvents)

        const allEvents = []
        for(let idx in blockEvents.txs) {
            const txMap = blockEvents.txs_map[idx]

            allEvents.push(...txMap.map(e => {
                return blockEvents.events[e]
            }))
        }
        for(let eventIdx in allEvents) {
            const event = allEvents[eventIdx] 
            
            if(EventOpType['ledger:transfer'] === event.t) {
                await this.ledgerDb.findOneAndUpdate({
                    id: `${blockId}-${eventIdx}`,
                }, {
                    $set: {
                        t: 'transfer',
                        owner: event.owner,
                        amount: event.amt,
                        tk: event.tk,
                        block_height: blockHeight,
                        memo: event.memo
                    }

                }, {
                    upsert: true
                })
                balancesUpdated[event.owner] = true
            } else if(EventOpType['ledger:withdraw'] === event.t) {
                if(event.owner.startsWith("#withdraw")) {
                    const [,queryString] = event.owner.split('?')
                    
                    await this.withdrawDb.findOneAndUpdate({ 
                        id: `${blockId}-${eventIdx}`
                    }, {
                        $set: {
                            status: "PENDING",
                            t: 'withdraw',
                            dest: new URLSearchParams(queryString).get('to'),
                            amount: event.amt,
                            tk: event.tk,

                            height: blockHeight,
                            idx: Number(eventIdx),
                            block_height: blockHeight,
                        }
                    }, {
                        upsert: true
                    })
                } else {
                    await this.ledgerDb.findOneAndUpdate({
                        id: `${blockId}-${eventIdx}`,
                    }, {
                        $set: {
                            t: 'transfer',
                            owner: event.owner,
                            amount: event.amt,
                            tk: event.tk,
                            block_height: blockHeight,
                            memo: event.memo
                        }
                    }, {
                        upsert: true
                    })
                    balancesUpdated[event.owner] = true
                }
            }
        }
        for(let owner of Object.keys(balancesUpdated)) {
            const ownershipInfo = await this.getSnapshot(owner, blockHeight)
            console.log('owner, ownershipInfo', owner, ownershipInfo)

            await this.balanceDb.findOneAndUpdate({
                account: owner,
                block_height: blockHeight
            }, {
                $set: {
                    tokens: ownershipInfo.tokens
                }
            }, {
                upsert: true
            })
        }
    }

    /**
     * Creates batch TX
     * @param block_height 
     * @returns 
     */
    async createWithdrawTx(block_height: number) {
        const withdrawals = await this.withdrawDb.find({ 
            status: "PENDING",
            // block_height: {
            //     $gte: block_height
            // }
        }).toArray()
        // console.log(withdrawals, {
        //     withdrawals: withdrawals.map(e => {
        //         console.log('e', e)
        //         return {
        //             amount: e.amount,
        //             unit: e.unit,
        //             dest: e.dest
        //         }
        //     })
        // })
        if(withdrawals.length === 0) { 
            throw new Error('No withdrawals to process')
        }
        const withdrawalData = {
            withdrawals: withdrawals.map(e => {
                return {
                    id: e.id,
                    amount: e.amount,
                    unit: e.tk,
                    dest: e.dest
                }
            })
        }
        const packedWithdraws = (await this.self.ipfs.dag.put(withdrawalData)).toString()


        const transaction = await this.self.witness.multisig.constructHiveTx([
            [
                'custom_json',
                {
                    id: 'vsc.bridge_ref',
                    required_auths: [this.multisigAccount],
                    required_posting_auths: [],
                    json: JSON.stringify({
                        ref_id: packedWithdraws
                    })
                }
            ],
           ...withdrawals.map(e => {
            
            return [
                'transfer',
                {
                    from: this.multisigAccount,
                    to: e.dest,
                    amount: `${(e.amount / 1_000).toFixed(3)} ${e.tk}`,
                    memo: 'Withdrawal from VSC network'
                }
            ] as const
           })
            
        ], block_height, moment.duration(30, 'seconds').asMilliseconds())

        return transaction;
    }

    /** 
     * Creates a batch transfer operation for withdrawals.
     * Packs
    */
    async runBatchOperation(block_height) {
        const transaction = await this.createWithdrawTx(block_height)
        const hiveTx = new HiveTx.Transaction(transaction)
        // hiveTx.sign(HiveTx.PrivateKey.from(this.self.config.get('identity.signing_keys.owner')))
        const {drain} = await this.self.p2pService.multicastChannel.call('multisig.withdraw', {
            payload: {
                block_height: block_height,
            },
            streamTimeout: 5_000
        })

        const [multisigAccount] = await HiveClient.database.getAccounts([networks[this.self.config.get('network.id')].multisigAccount])

        const key_auths = multisigAccount.owner.key_auths.map(e => e[0])
        //console.log(key_auths)

        let signatures = []
        for await (let data of drain) {
            const { payload } = data
            const derivedPublicKey = HiveTx.Signature.from(payload.signature).getPublicKey(hiveTx.digest().digest).toString()
            
            if (key_auths.includes(derivedPublicKey)) {
                if(!signatures.includes(payload.signature)) {
                    signatures.push(payload.signature)
                }
                if (multisigAccount.owner.weight_threshold <= signatures.length) {
                    break
                }
            }
        }

        const what = hive.auth.signTransaction({
            ...transaction
        }, []);
        what.signatures = signatures
        console.log('sending tx confirm', `weight_threshold=${multisigAccount.owner.weight_threshold}`, `signatures=${signatures.length}`)
        if(multisigAccount.owner.weight_threshold <= signatures.length  ) { 
            try {
                const txConfirm = await HiveClient.broadcast.send(what)
                console.log('Sending txConfirm', txConfirm)
            } catch (ex) {
                console.log(ex)
            }
        } else {
            console.log('not fully signed')
        }
    }

    async handleTxTick(args: ParserFuncArgs<'tx'>) {
        const {tx} = args.data;


        

        const headerOp = tx.operations[0]

        if(headerOp[0] === 'custom_json') { 
            const opBody = headerOp[1]
            if(opBody.id === 'vsc.bridge_ref' && opBody.required_auths[0] === this.multisigAccount) {
                try {
                    const json = JSON.parse(opBody.json)
                    const withdrawals = (await this.self.ipfs.dag.get(CID.parse(json.ref_id))).value.withdrawals

                    for(let withdraw of withdrawals) {
                        await this.withdrawDb.findOneAndUpdate({
                            id: withdraw.id
                        }, {
                            $set: {
                                status: "COMPLETE",
                                withdraw_id: tx.transaction_id
                            }
                        })
                    }

                    for(let account of withdrawals.map(e => e.dest)) {
                        const balanceSnapshot = await this.getSnapshot(account.dest, args.data.blkHeight)
                        await this.balanceDb.findOneAndUpdate({
                            account: account,
                            block_height: balanceSnapshot.block_height
                        }, {
                            $set: {
                                tokens: balanceSnapshot.tokens,
                            }
                        }, {
                            upsert: true
                        })
                    }
                } catch {
                    console.log('Could not parse ref')
                }
                
                //Only return IF TX is actually a batch withdrawal
                return;
            }
        }

        let idx = -1;
        for(let op of tx.operations) {
            idx = idx + 1;
            const [type, opBody] = op;
            if(type === 'transfer') {
                const [amount, unit] = (opBody.amount as string).split(' ')
                if(this.multisigAccount === opBody.to) {
                    //Decode JSON or query string
                    let decodedMemo = {};
                    try {
                        decodedMemo = JSON.parse(opBody.memo)
                    } catch {
                        const queryString = new URLSearchParams(opBody.memo)
                        for(let [key, value] of queryString.entries()) {
                            decodedMemo[key] = value
                        }
                    }
                    
                    let normalDest;
                    //Parse out the owner of the deposit or intended owner.
                    //Default to sender if no memo is attached
                    //Make sure it is only a valid Hive account or DID
                    const ethReg = new RegExp('^(0x)?[0-9a-fA-F]{40}$')
                    const hiveReg = new RegExp('^(?=.{3,16}$)[a-z][0-9a-z\-]{1,}[0-9a-z]([\.][a-z][0-9a-z\-]{1,}[0-9a-z]){0,}$')

                    if(decodedMemo['to']?.startsWith('did:key')) {
                        normalDest = decodedMemo['to']
                    } else if (decodedMemo['to']?.startsWith('did:pkh:eip155:1')) {
                        
                        //Valid matching regex
                        if(ethReg.test(decodedMemo['to'].replace('did:pkh:eip155:1:', ''))) {
                            normalDest = decodedMemo['to']
                        } else {
                            normalDest = `hive:${opBody.from}`
                        }
                    } else if(decodedMemo['to']?.startsWith('@')) {
                        const [,username] = decodedMemo['to'].split('@')[":"]

                        if(hiveReg.test(username)) { 
                            normalDest = `hive:${username}`
                        } else {
                            //Make sure it defaults correctly
                            normalDest = `hive:${opBody.from}`
                        }
                    } else if(decodedMemo['to']?.startsWith('hive:')) {
                        //In the future apply hive regex to verify proper deposit
                        const [,username] = decodedMemo['to'].split('hive:')[":"]

                        if(hiveReg.test(username)) { 
                            normalDest = decodedMemo['to']
                        } else {
                            //Make sure it defaults correctly
                            normalDest = `hive:${opBody.from}`
                        }
                    } else if(ethReg.test(decodedMemo['to'])) {
                        normalDest = `did:pkh:eip155:1:${eip55.encode(decodedMemo['to'])}`
                    } else {
                        normalDest = `hive:${opBody.from}`
                    }

                    if(decodedMemo['action'] === 'donate_fill') {
                        //For now don't account anything
                        return;
                    }

                    if(decodedMemo['action'] === 'donate') { 
                        //In the future donate to consensus running witnesses
                        return;
                    }

                    
                    if(decodedMemo['action'] === 'withdraw') { 
                        const balanceSnapshot = await this.getSnapshot(opBody.from, args.data.blkHeight)
                        //Return the full deposit amount + requested amount
                        
                        //Must shorten to 3 decimal places as Hive only goes to a max of 1.000
                        const requestedAmount = Number(Number(decodedMemo['amount']).toFixed(3)) * 1_000
                        const sentAmount = Number(amount) * 1_000
                        const withdrawlAmount = requestedAmount + sentAmount
                        const dest = decodedMemo['to'] || opBody.from

                        await this.self.transactionPool.txDb.findOneAndUpdate({
                            id: `${tx.transaction_id}-${idx}`,
                        }, {
                            $set: {
                                status: TransactionDbStatus.included,
                                required_auths: [
                                    {
                                        value: `hive:${opBody.from}`,
                                        type: 'active'
                                    }
                                ],
                                headers: {
                                    type: TransactionDbType.input
                                },
                                data: {
                                    op: "withdraw",
                                    payload: {
                                        from: `hive:${opBody.from}`,
                                        to: normalDest,
                                        amount: withdrawlAmount,
                                        tk: unit,
                                    }
                                },
                                first_seen: new Date(), //Fix this
                                local: false,
                                accessible: false,
                                src: 'hive',
                                anchored_block: args.data.block_id,
                                anchored_height: args.data.blkHeight,
                                anchored_id: args.data.block_id,
                                anchored_index: args.data.idx
                            }
                        }, {
                            upsert: true
                        })
                    }
                    //Insert deposit always
                    await this.ledgerDb.findOneAndUpdate({
                        id: `${tx.transaction_id}-${idx}`,
                    }, {
                        $set: {
                            t: 'deposit',
                            amount: Number(amount) * 1_000,
                            //Must be HIVE or HBD
                            //TODO: fix upstream type
                            tk: unit as "HIVE" | "HBD",
                            from: opBody.from,
                            owner: normalDest,
                            block_height: args.data.blkHeight,

                            tx_id: tx.transaction_id
                        }
                    }, {
                        upsert: true
                    })
                }
            }
        }
    }

    async handleBlockTick(args) { 
        const {key:blkHeight} = args.data;
        if(blkHeight % 20 === 0 && this.self.chainBridge.parseLag < 5) {
            const witnessSchedule = await this.self.witness.getBlockSchedule(blkHeight)
            const scheduleSlot = witnessSchedule.find(e => e.bn >= blkHeight)
            if(scheduleSlot && scheduleSlot.account === process.env.HIVE_ACCOUNT) {
                this.runBatchOperation(blkHeight).catch((e) => {
                    console.log(e)
                })
            }
        }
    }


    async handleMessage(args) {
        const {block_height} = args.message

        const witnessInfo = await this.self.chainBridge.witnessDb.findOne({
            ipfs_peer_id: args.from
        })
        console.log(witnessInfo.account)
        console.log(makeSimpleObjectText({
            from: args.from,
            block_height: block_height,
            last_block: this.self.chainBridge.streamParser.stream.lastBlock,
            ts: args.ts
        }))
        
        // console.log('withdraw action', block_height)
        if(block_height < this.self.chainBridge.streamParser.stream.lastBlock && block_height % 20 === 0) {
            console.log('withdraw action RUN', block_height)
            try {
                const withdrawTx = await this.createWithdrawTx(block_height)
                

                const [multisigAccount] = await HiveClient.database.getAccounts([networks[this.self.config.get('network.id')].multisigAccount])


                
                let signingKey;
                for(let account of ['vsc.ms-8968d20c', networks[this.self.config.get('network.id')].multisigAccount]) { 
                    const privKey = PrivateKey.fromLogin(account, Buffer.from(this.self.config.get('identity.walletPrivate'), 'base64').toString(), 'owner')
                    
                    if(!!multisigAccount.owner.key_auths.map(e => e[0]).find(e => e.toString() === privKey.createPublic().toString())) {
                        signingKey = privKey
                        break;
                    }
                }

                if(!signingKey) {
                    if(process.env.MULTISIG_STARTUP_OWNER) {
                        signingKey = PrivateKey.fromString(process.env.MULTISIG_STARTUP_OWNER)
                    } else {
                        console.log('Error: No signing key found - Not in signing list')
                        return;
                    }
                }

                const signedTx = hive.auth.signTransaction(withdrawTx, [signingKey.toString()]);
                args.drain.push({
                    signature: signedTx.signatures[0]
                })
            } catch(ex) {
                console.log(ex)

            }
        }
    }

    async init() {
        this.ledgerDb = this.self.db.collection('bridge_ledger')
        this.withdrawDb = this.self.db.collection('bridge_withdrawals')
        this.balanceDb = this.self.db.collection('bridge_balances')

        this.self.chainBridge.streamParser.addParser({
            priority: 'before',
            type: 'tx',
            func: this.handleTxTick.bind(this),
        })
        this.self.chainBridge.streamParser.addParser({
            priority: 'after',
            type: 'block',
            func: this.handleBlockTick.bind(this),
        })
        // const blockHeight = await HiveClient.blockchain.getCurrentBlockNum()
        
        await this.self.p2pService.multicastChannel.register('multisig.withdraw', this.handleMessage.bind(this), {
            loopbackOk: true
        })
        // setTimeout(async() => { 
        //     await this.createBatchOperation(blockHeight)
        // }, 5_000)
    }

    async start() {
        
    }
}