import {Transaction} from '@hiveio/dhive'
import { NewCoreService } from '..';
import { Collection } from 'mongodb';
import * as HiveTx from 'hive-tx';
import hive from '@hiveio/hive-js';
import { CID } from 'kubo-rpc-client'
import networks from '../../../services/networks';
import { HiveClient, HiveClient2 } from '../../../utils';
import moment from 'moment';
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
    withdrawDb: Collection;
    ledgerDb: Collection;
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
        const lastBalance = await this.balanceDb.findOne({account: 'fakeaccoun'})

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
            unit: 'HIVE',
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
            unit: 'HBD',
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
        console.log(key_auths)
        let signatures = []
        for await (let data of drain) {
            const { payload } = data
            const derivedPublicKey = HiveTx.Signature.from(payload.signature).getPublicKey(hiveTx.digest().digest).toString()
            console.log(derivedPublicKey)
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
        console.log('sending tx confirm', multisigAccount.owner.weight_threshold,  signatures.length )
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
                const [amount, unit] = opBody.amount.split(' ')
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
                    //Parse out the owner of the deposit or intended owner.
                    //Default to sender if no memo is attached
                    if(decodedMemo['to']?.startsWith('did:') || decodedMemo['to']?.startsWith('@')) {
                        decodedMemo['owner'] = decodedMemo['to']
                    } else {
                        decodedMemo['owner'] = opBody.from
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

                        if(balanceSnapshot.tokens[unit] >= withdrawlAmount) {
                            //Withdraw funds
                            
                            const withdrawRecord = await this.withdrawDb.findOne({
                                id: `${tx.transaction_id}-${idx}`
                            })
                            if(!withdrawRecord) { 
                                await this.withdrawDb.findOneAndUpdate({
                                    id: `${tx.transaction_id}-${idx}`,
                                }, {
                                    $set: {
                                        status: "PENDING",
                                        amount: withdrawlAmount,
                                        unit,
                                        from: opBody.from,
                                        dest,
                                    }
                                }, {
                                    upsert: true
                                })
                            }

                            await this.ledgerDb.findOneAndUpdate({
                                id: `${tx.transaction_id}-${idx}`,
                                owner: opBody.from,
                            }, {
                                $set: {
                                    amount: -requestedAmount,
                                    unit,
                                    dest: opBody.from,
                                    block_height: args.data.blkHeight
                                }
                            }, {
                                upsert: true
                            })
                        } else {
                            //Insufficient funds. Log deposit amount
                            const withdrawRecord = await this.withdrawDb.findOne({
                                id: `${tx.transaction_id}-${idx}`
                            })
                            if(!withdrawRecord) {
                                await this.withdrawDb.findOneAndUpdate({
                                    id: `${tx.transaction_id}-${idx}`,
                                }, {
                                    $set: {
                                        status: "PENDING",
                                        amount: sentAmount,
                                        unit,
                                        dest,
                                        type: "INSUFFICIENT_FUNDS",
                                        block_height: args.data.blkHeight
                                    }
                                }, {
                                    upsert: true
                                })
                            }
                        }
                        
                    } else {
                        //Insert deposit IF not withdraw
                        await this.ledgerDb.findOneAndUpdate({
                            id: `${tx.transaction_id}-${idx}`,
                        }, {
                            $set: {
                                amount: Number(amount) * 1_000,
                                unit: unit,
                                from: opBody.from,
                                owner: decodedMemo['owner'],
                                block_height: args.data.blkHeight
                            }
                        }, {
                            upsert: true
                        })
                    }
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
        
        // console.log('withdraw action', block_height)
        if(block_height > this.self.chainBridge.streamParser.stream.lastBlock - 20 && block_height % 20 === 0) {
            // console.log('withdraw action RUN', block_height)
            try {
                const withdrawTx = await this.createWithdrawTx(block_height)
                

                const [multisigAccount] = await HiveClient.database.getAccounts([networks[this.self.config.get('network.id')].multisigAccount])

                let signingKey;
                for(let account of ['vsc.ms-8968d20c', networks[this.self.config.get('network.id')].multisigAccount]) { 
                    const privKey = PrivateKey.fromLogin(account, Buffer.from(this.self.config.get('identity.nodePrivate'), 'base64').toString(), 'owner')
                    
                    if(!!multisigAccount.owner.key_auths.map(e => e[0]).find(e => e === privKey.createPublic().toString())) {
                        signingKey = privKey
                        break;
                    }
                }

                if(!signingKey && process.env.MULTISIG_STARTUP_OWNER) {
                    signingKey = PrivateKey.fromString(process.env.MULTISIG_STARTUP_OWNER)
                } else {
                    console.log('Error: No signing key found - Not in signing list')
                    return;
                }

                const signedTx = hive.auth.signTransaction(withdrawTx, [process.env.TEST_KEY || this.self.config.get('identity.signing_keys.owner')]);
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