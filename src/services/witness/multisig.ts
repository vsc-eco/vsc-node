import { PrivateKey, Transaction } from "@hiveio/dhive";
import moment from 'moment'
import { HiveClient } from "../../utils";
import { CoreService } from "..";


export class MultisigCore {
    self: CoreService;

    constructor(self: CoreService) {
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
            expiration: moment().add('12', 'seconds').toDate().toISOString().slice(0, -5),
            operations: [
                ['account_update', {
                    account: process.env.MULTISIG_ACCOUNT,
                    owner: {
                        account_auths: multisigAccount.owner.account_auths,
                        key_auths: [...multisigAccount.owner.key_auths, ...(await candidateNodes).map(e => {
                            return [(e as any).signing_keys.owner,1]
                        })],
                        weight_threshold: 1
                    },
                    memo_key: multisigAccount.memo_key,
                    json_metadata: ''
                }]
            ],
            extensions: []
        }
        // console.log(JSON.stringify(transaction, null, 2))
        const signedTx = await HiveClient.broadcast.sign(transaction, PrivateKey.from(this.self.config.get('identity.signing_keys.owner')))
        // console.log(signedTx)

        const {drain} = await this.self.p2pService.multicastChannel.call('multisig.request_rotate', {
            payload: {
                transaction
            },
            streamTimeout: 2000
        })

        let signatures = []
        for await(let {payload} of drain) {
            console.log('sigData', payload)
            signatures.push(payload.signature)
        }
        
        console.log('signature end', signatures)

    }

    async start() {
        this.self.p2pService.multicastChannel.register('multisig.request_rotate', async({
            message,
            drain,
            from
        }) => {
            const peerInfo = await this.self.p2pService.peerDb.findOne({
                peer_id: from
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
                peer_id: from
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
    }
}