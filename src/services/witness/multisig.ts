import { PrivateKey, Transaction } from "@hiveio/dhive";
import moment from 'moment'
import hive from '@hiveio/hive-js'
import { HiveClient } from "../../utils";
import { CoreService } from "..";
import { WitnessService } from ".";

hive.api.setOptions({ url: 'https://api.hive.blog' })

export class MultisigCore {
    witness: WitnessService;
    self: CoreService;

    constructor(self: CoreService, witness: WitnessService) {
        this.witness = witness
        this.self = self;
    }


    async triggerKeyrotation() {
        const candidateNodes = (await this.self.p2pService.peerDb.find({
            anti_hack_trusted: true,
            "signing_keys.owner": {$exists: true}
        })).toArray()

        const bh = await HiveClient.blockchain.getCurrentBlock();
        const [multisigAccount] = await HiveClient.database.getAccounts([process.env.MULTISIG_ACCOUNT])
       
        const transaction: Transaction = {
            ref_block_num: parseInt(bh.block_id.slice(0, 8), 16) & 0xffff,
            ref_block_prefix: Buffer.from(bh.block_id, 'hex').readUInt32LE(4),
            expiration: moment().add('60', 'seconds').toDate().toISOString().slice(0, -5),
            operations: [
                ['account_update', {
                    account: process.env.MULTISIG_ACCOUNT,
                    owner: {
                        account_auths: multisigAccount.owner.account_auths,
                        key_auths: [
                            ['STM5px4YmWK2PHAdYaZLP5XoUF8gsbhW5H4kbzxZ5ycijkoRJ4WT9', 1], 
                            ['STM7HSab8XBtjWqt4QLoQqiBnYz1P5gHpiduS3Cj28p17p1EhPKxq', 1],
                            ['STM76k1Wm8Z4MPYoRe9JejVAPinfkLFVr9EJjsoN48z4DeWGji2tm', 1],
                            ['STM5M2ATW8CgfJeHrCBmCrXQypUcb9TxouFYdbF3nKxwbz3BwBG8t', 1]
                        ],
                        // key_auths: [...multisigAccount.owner.key_auths, ...(await candidateNodes).map(e => {
                        //     return [(e as any).signing_keys.owner,1]
                        // })],
                        // key_auths: [
                        //     ...(await candidateNodes).map(e => {
                        //         return [(e as any).signing_keys.owner, 1]
                        //     }), 
                        //     ['STM5px4YmWK2PHAdYaZLP5XoUF8gsbhW5H4kbzxZ5ycijkoRJ4WT9', 1]
                        // ],
                        weight_threshold: 1
                    },
                    memo_key: multisigAccount.memo_key,
                    json_metadata: '{"test": "Signed with multisig"}'
                }]
            ],
            extensions: []
        }
        // const transaction: Transaction = {
        //     ref_block_num: parseInt(bh.block_id.slice(0, 8), 16) & 0xffff,
        //     ref_block_prefix: Buffer.from(bh.block_id, 'hex').readUInt32LE(4),
        //     expiration: moment().add('60', 'seconds').toDate().toISOString().slice(0, -5),
        //     operations: [
        //         ['custom_json', {
        //             required_auths:	[process.env.MULTISIG_ACCOUNT],
        //             required_posting_auths:[],
                
        //             id: "test-test-test-test",
        //             json: '{"test": "Signed with multisig"}'
        //         }]
        //     ],
        //     extensions: []
        // }
        
        // hive.broadcast.send(transactionTest, [this.self.config.get('identity.signing_keys.owner')], (err, result) => {
        //     console.log(err, result);
        //   })
        // console.log(JSON.stringify(transaction, null, 2))
        // const signedTestTx = await hive.broadcast._prepareTransaction({
        //     operations: transaction.operations,
        //     extensions: transaction.extensions
        // })
        // console.log(signedTestTx)
        const what = hive.auth.signTransaction({
            ...transaction
        }, [this.self.config.get('identity.signing_keys.owner')]);
        console.log(what)
        // const signedTx = await HiveClient.broadcast.sign(transaction, PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner')))
        // console.log(JSON.stringify(signedTx, null, 2))

        const {drain} = await this.self.p2pService.multicastChannel.call('multisig.request_rotate', {
            payload: {
                transaction
            },
            streamTimeout: 2000
        })

        let signatures = []
        for await(let {payload} of drain) {
            console.log('sigData', payload)
            if(multisigAccount.owner.weight_threshold >= signatures.length + 1) {
                break;
            }
            // signatures.push(payload.signature)
        }
        
        // console.log('signature end', signatures, PrivateKey.from(this.self.config.get('identity.signing_keys.owner')).createPublic().toString())
        // signedTx.signatures.push(...signatures)
        // console.log(signedTx.signatures)
        const txConfirm = await HiveClient.broadcast.send(what)
        console.log(txConfirm)
        // hive.api.broadcastTransactionSynchronous(signedTx, function(err, result) {
        //     console.log(err, result);
        //   });
          
    }

    async custom_json() {
        const bh = await HiveClient.blockchain.getCurrentBlock();
        const transaction: Transaction = {
            ref_block_num: parseInt(bh.block_id.slice(0, 8), 16) & 0xffff,
            ref_block_prefix: Buffer.from(bh.block_id, 'hex').readUInt32LE(4),
            expiration: moment().add('60', 'seconds').toDate().toISOString().slice(0, -5),
            operations: [
                ['custom_json', {
                    required_auths:	[],
                    required_posting_auths:[process.env.MULTISIG_ACCOUNT],
                
                    id: "test-test-test-test",
                    json: '{"test": "Signed with multisig"}'
                }]
            ],
            extensions: []
        }

        const signedTx = await HiveClient.broadcast.sign(transaction, PrivateKey.fromString(this.self.config.get('identity.signing_keys.posting')))

        const {drain} = await this.self.p2pService.multicastChannel.call('multisig.sign_posting', {
            payload: {
                transaction
            },
            streamTimeout: 12000
        })

        let signatures = []
        for await(let {payload} of drain) {
            console.log('sigData', payload)
            signatures.push(payload.signature)
        }
        signedTx.signatures = signatures;
        console.log(signedTx.signatures)
        const txConfirm = await HiveClient.broadcast.send(signedTx)
        console.log(txConfirm)
    }

    async testSuite() {
        // await this.custom_json()
        await this.triggerKeyrotation()
    }
    async start() {
        this.self.p2pService.multicastChannel.register('multisig.request_rotate', async({
            message,
            drain,
            from
        }) => {
            const peerInfo = await this.self.p2pService.peerDb.findOne({
                peer_id: from.toString()
            })

            if((peerInfo as any)?.anti_hack_trusted === true) { 
                const rawTransaction = message.transaction
    
                const key = PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner'))
                const signedTransaction = await HiveClient.broadcast.sign(rawTransaction, key)
                drain.push({
                    signature: signedTransaction.signatures[0]
                })
                drain.end()
            } else {
                drain.end()
            }
        })
        this.self.p2pService.multicastChannel.register('multisig.sign_posting', async({
            message,
            drain,
            from
        }) => {
            const peerInfo = await this.self.p2pService.peerDb.findOne({
                peer_id: from.toString()
            })
            const rawTransaction = message.transaction
            
            if((peerInfo as any)?.anti_hack_trusted === true) {
                const key = PrivateKey.fromString(this.self.config.get('identity.signing_keys.posting'))
                const signedTransaction = await HiveClient.broadcast.sign(rawTransaction, key)
                drain.push({
                    signature: signedTransaction.signatures[0]
                })
                drain.end()
            } else {
                //Do nothing
                drain.end()
            }
        })
        // this.testSuite()
    }
}