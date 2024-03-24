import {Transaction} from '@hiveio/dhive'
import { NewCoreService } from '..';
import { Collection } from 'mongodb';
import * as HiveTx from 'hive-tx';
import hive from '@hiveio/hive-js';
import { CID } from 'kubo-rpc-client'
import networks from '../../../services/networks';
import { HiveClient, HiveClient2 } from '../../../utils';
import moment from 'moment';

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


const SIMPLE_INSTRUCTIONS = [
    'deposit'
]

/**
 * Manages multisig balances, deposits, and withdrawals
 */
export class BalanceKeeper {
    self: NewCoreService;
    balanceDb: Collection<BalanceType>
    receiptDb: Collection<TxReceipt>;
    withdrawDb: Collection;
    depositDb: Collection;
    batchDb: Collection;
    constructor(self: NewCoreService) {
        this.self = self;
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
        const lastBalance = await this.balanceDb.findOne({account: account})

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

        const hiveDeposits = await this.depositDb.find({
            unit: 'HIVE',
            from: account
        }, {
            sort: {
                block_height: 1
            }
        }).toArray()
        const hbdDeposits = await this.depositDb.find({
            unit: 'HBD',
            from: account
        }, {
            sort: {
                block_height: 1
            }
        }).toArray()

        const hiveAmount = hiveDeposits.map(e => e.amount).reduce((acc, cur) => { 
            console.log(acc)
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
                    unit: e.unit,
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
            console.log('regular time', {
                from: this.multisigAccount,
                to: e.dest,
                amount: `${e.amount / 1_000} ${e.unit}`,
                memo: 'Withdrawal from VSC network'
            })
            return [
                'transfer',
                {
                    from: this.multisigAccount,
                    to: e.dest,
                    amount: `${(e.amount / 1_000).toFixed(3)} ${e.unit}`,
                    memo: 'Withdrawal from VSC network'
                }
            ]
           }) as any
            
        ], block_height, moment.duration(120, 'seconds').asMilliseconds())

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
        let signatures = []
        for await (let data of drain) {
            const { payload } = data
            const derivedPublicKey = HiveTx.Signature.from(payload.signature).getPublicKey(new HiveTx.Transaction(transaction).digest().digest).toString()
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
        // console.log('sending tx confirm')
        // if(multisigAccount.owner.weight_threshold <= signatures.length  ) { 
            try {
                const txConfirm = await HiveClient2.broadcast.send(what)
                console.log('Sending txConfirm', txConfirm)
            } catch (ex) {
                console.log(ex)
            }
        // } else {
        //     // console.log('not fully signed')
        // }
    }

    async handleTxTick(args) {
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
                const [amount, unit] = opBody.amount.split(' ')
                if(this.multisigAccount === opBody.to) { 
                    let decodedMemo = {};
                    try {
                        decodedMemo = JSON.parse(opBody.memo)
                    } catch {
                        const queryString = new URLSearchParams(opBody.memo)
                        for(let [key, value] of queryString.entries()) {
                            decodedMemo[key] = value
                        }
                    }
                    if(decodedMemo['to']?.startsWith('did:') || decodedMemo['to']?.startsWith('@')) {
                        decodedMemo['owner'] = decodedMemo['to']
                    } else {
                        decodedMemo['owner'] = opBody.from
                    }
                    if(decodedMemo['action'] === 'withdraw') { 
                        const balanceSnapshot = await this.getSnapshot(opBody.from, args.data.blkHeight)
                        console.log(balanceSnapshot)
                        //Return the full deposit amount + requested amount
                        const withdrawlAmount = Number(decodedMemo['amount']) * 1_000 + Number(amount) * 1_000
                        if(balanceSnapshot.tokens[unit] >= withdrawlAmount) {
                            //Withdraw funds
                            await this.withdrawDb.insertOne({
                                id: `${tx.transaction_id}-${idx}`,
                                status: "PENDING",
                                amount: withdrawlAmount,
                                unit: unit,
                                dest: opBody.from,
                            })
                        } else {
                            //Insufficient funds. Log deposit amount
                        }
                    }

                    await this.depositDb.insertOne({
                        amount: Number(amount) * 1_000,
                        unit: unit,
                        to: opBody.to,
                        from: opBody.from,
                        owner: decodedMemo['owner'],
                        block_height: args.data.blkHeight
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
                this.runBatchOperation(blkHeight).catch(() => {})
            }
        }
    }


    async handleMessage(args) {
        const {block_height} = args.message
        
        // console.log('withdraw action', block_height)
        if(block_height > this.self.chainBridge.streamParser.stream.lastBlock - 20 && block_height % 20 === 0) {
            // console.log('withdraw action RUN', block_height)
            try {
                const withdrawTx = await this.createWithdrawTx(block_height)
                const hiveTx = new HiveTx.Transaction(withdrawTx).sign(
                    HiveTx.PrivateKey.from(process.env.TEST_KEY || this.self.config.get('identity.signing_keys.owner'))
                )
             
                args.drain.push({
                    signature: hiveTx.signatures[0]
                })
            } catch {

            }
        }
    }

    async init() {
        this.receiptDb = this.self.db.collection('receipts')
        this.depositDb = this.self.db.collection('deposits')
        this.withdrawDb = this.self.db.collection('withdrawals')
        this.balanceDb = this.self.db.collection('balances')
        this.batchDb = this.self.db.collection('multisig_batches')

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