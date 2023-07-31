import { PrivateKey, Transaction } from "@hiveio/dhive";
import moment from 'moment'
import hive from '@hiveio/hive-js'
import { HiveClient, calcBlockInterval } from "../../utils";
import { CoreService } from "..";
import { WitnessService } from ".";

hive.api.setOptions({ url: 'https://api.hive.blog' })


export function createSafeDivision(options: {
    factorMin: number
    factorMax: number
    map: any[]
}) {
    const {map, factorMin, factorMax} = options;

    let cutArray;
    if(map.length % 2 === 0) {
        cutArray = map.slice(0, map.length - 1)
    } else {
        cutArray = map
    }
    
    const factor = factorMin / factorMax

    return {
        threshold: Math.round(map.length * factor),
        total: cutArray.length,
        key_auths: map.map(e => [e.signing_keys.owner, 1]),
        signers_owner: {
            weight_threshold: Math.round(map.length * factor)
        },
        signers_active: map.slice(0, Math.round(map.length * factor)).map(e => e.signing_keys.active),
        signers_posting: map.slice(0, Math.round(map.length * factor)).map(e => e.signing_keys.posting)
    }
}

function convertDurationToHiveBlocks(dur: string, unit: moment.unitOfTime.DurationConstructor) {
   const tim = moment.duration(dur, unit);

   return tim.asSeconds() / 3;
}

export class MultisigCore {
    witness: WitnessService;
    self: CoreService;
    multisigOptions: {
        rotationIntervalHive?: number; rotationInterval: string; 
};
    private _rotationRunning: boolean;
    lastRotateBlock: number | null;
    sentTest: boolean;
    runnerTags: any;

    constructor(self: CoreService, witness: WitnessService) {
        this.witness = witness
        this.self = self;

        this.multisigOptions = {
            rotationInterval: '6'
        }
        this.runnerTags = {}
        this.multisigOptions.rotationIntervalHive = convertDurationToHiveBlocks('6', 'h')
        this.lastRotateBlock = null
    }


    async broadcastOpMultisig() {
        const bh = await HiveClient.blockchain.getCurrentBlock();

        const transaction: Transaction = {
            ref_block_num: parseInt(bh.block_id.slice(0, 8), 16) & 0xffff,
            ref_block_prefix: Buffer.from(bh.block_id, 'hex').readUInt32LE(4),
            expiration: moment().add('60', 'seconds').toDate().toISOString().slice(0, -5),
            operations: [
                ['transfer', {
                    
                }],
                [
                    'custom_json',
                    {
                        required_posting_auths: [process.env.MULTISIG_ACCOUNT],
                        id: "vsc.multisig_txref",
                        json: JSON.stringify({
                            'ref_id': 'test-test-test'
                        })
                    }
                ]
            ],
            extensions: []
        }
        // HiveClient.broadcast.sendOperations([['transfer', {
            
        // }]], PrivateKey.fromString(this.self.config.get('identity.signing_keys.active')))
        console.log('broadcast transaction in progress', transaction)
    }
    
    /**
     * Takes a look at output data 
     */
    async broadcastOutput() {

    }

    async triggerKeyrotation() {
        const consensusRound = await this.self.witness.calculateConsensusRound()
        const candidateNodes = await this.witness.witnessDb.find({
            $or: [
              {
                disabled_at: {
                  $gt: consensusRound.pastRoundHash,
                },
              },
              {
                disabled_at: {
                  $exists: false,
                },
              },
              {
                disabled_at: {
                  $eq: null
                },
              },
            ],
            trusted: true,
            net_id: this.self.config.get('network.id'),
            enabled_at: {
              $lt: consensusRound.pastRoundHash,
            },
            last_signed: {
              $gt: moment().subtract('7', 'day').toDate()
            },
            plugins: 'multisig'
          }).toArray()

        const ownerKeys = candidateNodes.map(e => e.signing_keys.owner)
        const activeKeys = candidateNodes.map(e => e.signing_keys.active)
        const postingKeys = candidateNodes.map(e => e.signing_keys.posting)
        

        // console.log({
        //     ownerKeys,
        //     postingKeys,
        //     activeKeys
        // })
        
        const multisigConf = createSafeDivision({factorMax: 11, factorMin: 6, map: candidateNodes})
        // console.log(multisigConf)

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
                        account_auths: [['vaultec', multisigConf.threshold]],
                        key_auths: ownerKeys.map(e => [e, 1]),
                        // key_auths: [...multisigAccount.owner.key_auths, ...(await candidateNodes).map(e => {
                        //     return [(e as any).signing_keys.owner,1]
                        // })],
                        
                        weight_threshold: multisigConf.threshold
                    },
                    active: {
                        account_auths: multisigAccount.owner.account_auths,
                        key_auths: activeKeys.map(e => [e, 1]),
                        // key_auths: [...multisigAccount.owner.key_auths, ...(await candidateNodes).map(e => {
                        //     return [(e as any).signing_keys.owner,1]
                        // })],
                        
                        weight_threshold: multisigConf.threshold
                    },
                    posting: {
                        account_auths: multisigAccount.owner.account_auths,
                        key_auths: postingKeys.map(e => [e, 1]),
                        // key_auths: [...multisigAccount.owner.key_auths, ...(await candidateNodes).map(e => {
                        //     return [(e as any).signing_keys.owner,1]
                        // })],
                        
                        weight_threshold: multisigConf.threshold
                    },
                    memo_key: multisigAccount.memo_key,
                    json_metadata: '{"message": "This is a VSC multisig account ROTATION 2"}'
                }]
            ],
            extensions: []
        }
        // console.log(JSON.stringify(transaction, null, 2))
        
        
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
        // console.log(what)
        // // const signedTx = await HiveClient.broadcast.sign(transaction, PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner')))
        // // console.log(JSON.stringify(signedTx, null, 2))

        const {drain} = await this.self.p2pService.multicastChannel.call('multisig.request_rotate', {
            payload: {
                transaction,
                authority_type: 'owner'
            },
            mode: 'stream',
            streamTimeout: 12000,
            responseOrigin: 'many'
        })

        console.log(multisigAccount.owner)
        let signatures = [...what.signatures]
        for await(let {payload} of drain) {
            console.log('sigData',signatures.length, payload)
            if(multisigAccount.owner.weight_threshold <= signatures.length) {
                break;
            }
            signatures.push(payload.signature)
        }
        

        what.signatures = signatures
        
        // // console.log('signature end', signatures, PrivateKey.from(this.self.config.get('identity.signing_keys.owner')).createPublic().toString())
        // // signedTx.signatures.push(...signatures)
        // // console.log(signedTx.signatures)
        console.log('fully signed', what)
        const txConfirm = await HiveClient.broadcast.send(what)
        console.log(txConfirm)
        // hive.api.broadcastTransactionSynchronous(signedTx, function(err, result) {
        //     console.log(err, result);
        //   });
          
    }

    async custom_json() {
        const bh = await HiveClient.blockchain.getCurrentBlock();
        const [multisigAccount] = await HiveClient.database.getAccounts([process.env.MULTISIG_ACCOUNT])
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

        let signatures = [...signedTx.signatures]
        for await(let {payload} of drain) {
            // console.log('sigData', payload)
            if(multisigAccount.owner.weight_threshold <= signatures.length) {
                break;
            }
            signatures.push(payload.signature)
        }
        signedTx.signatures = signatures;
        // console.log(signedTx.signatures)
        // const txConfirm = await HiveClient.broadcast.send(signedTx)
        // console.log(txConfirm)
    }

    async processOutputs() {
        const outputsWithActions = await this.self.transactionPool.transactionPool.find({
            output_actions: {$ne: null},
            'output_actions.tx_id': {$exists: false}
        }).toArray()
        console.log('outputsWithActions', outputsWithActions)
       
        let outputActions = []
        for(let out of outputsWithActions) {
            outputActions.push(...out.output_actions.map(e => ({
                ...e,
                contract_id: out.headers.contract_id,
                output_id: out.id
            })))
        }
        for(let action of outputActions) {
            console.log(action)
            let tx;
            if(action.tx[0] === 'custom_json') {
                tx = ['custom_json', {
                    required_posting_auths: [process.env.MULTISIG_ACCOUNT],
                    required_auths: [],
                    id: "vsc.custom_json",
                    json: JSON.stringify({
                        net_id: this.self.config.get('network.id'),
                        contract_id: action.contract_id,
                        "vsc_json": typeof action.tx[1].json === 'string' ? JSON.parse(action.tx[1].json) : action.tx[1].json
                    })
                }]
            } else if(action[0] === 'transfer') {
                tx = action.tx
            } else {
                continue;
            }

            console.log('got here')

            const bh = await HiveClient.blockchain.getCurrentBlock();
            const [multisigAccount] = await HiveClient.database.getAccounts([process.env.MULTISIG_ACCOUNT])
            const transaction: Transaction = {
                ref_block_num: parseInt(bh.block_id.slice(0, 8), 16) & 0xffff,
                ref_block_prefix: Buffer.from(bh.block_id, 'hex').readUInt32LE(4),
                expiration: moment().add('60', 'seconds').toDate().toISOString().slice(0, -5),
                operations: [
                    tx,
                    [
                        'custom_json',
                        {
                            required_posting_auths: [process.env.MULTISIG_ACCOUNT],
                            required_auths: [],
                            id: "vsc.multisig_txref",
                            json: JSON.stringify({
                                'ref_id': action.output_id
                            })
                        }
                    ]
                ],
                extensions: []
            }

            const signedTx = await HiveClient.broadcast.sign(transaction, PrivateKey.fromString(this.self.config.get('identity.signing_keys.posting')))

            const {drain} = await this.self.p2pService.multicastChannel.call('multisig.sign_posting', {
                payload: {
                    transaction
                },
                responseOrigin: 'many',
                streamTimeout: 12000
            })

            let signatures = [...signedTx.signatures]
            for await(let {payload} of drain) {
                // console.log('sigData', payload)
                if(multisigAccount.owner.weight_threshold <= signatures.length) {
                    break;
                }
                signatures.push(payload.signature)
            }
            signedTx.signatures = signatures;

            console.log(signedTx)

            if(!this.sentTest) {
                const recipt = await HiveClient.broadcast.send(signedTx)
                console.log(recipt)
                await this.self.transactionPool.transactionPool.findOneAndUpdate({
                    id: action.output_id
                },{
                    $set: {
                        [`output_actions.${outputActions.indexOf(action)}.tx_id`]: recipt.id
                    }
                })
            }

            this.sentTest = true;

            
        }
    }

    isTagged(key) {
        return this.runnerTags[key]?.t || false
    }

    tagRunner(key) {
        if(!this.runnerTags[key]) {
            this.runnerTags[key] = {
                t: true
            }
        } else {
            this.runnerTags[key].t = true
        }
    }

    tagValue(key, value) {
        if(!this.runnerTags[key]) {
            this.runnerTags[key] = {
                v: value
            }
        } else {
            this.runnerTags[key].v = value
        }
    }

    untagRunner(key) {
        if(!this.runnerTags[key]) {
            this.runnerTags[key] = {
                t: false
            }
        } else {
            this.runnerTags[key].t = false
        }
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

        // setInterval(() => {
        //     this.custom_json()

        // }, 6000)

        setInterval(async() => {
            if(this.self.witness.witnessSchedule && this.self.chainBridge.hiveStream.blockLag < 5 && this.self.chainBridge.syncedAt && this.self.chainBridge.hiveStream.blockLag) {
                // console.log('Contract worker', this.self.witness.witnessSchedule, this.self.chainBridge.hiveStream.blockLag, this.self.chainBridge.syncedAt)
        
                const nodeInfo = await this.self.chainBridge.witnessDb.findOne({
                  did: this.self.identity.id,
                })
                if (nodeInfo) {
                    //   const scheduleSlot = this.self.witness.witnessSchedule?.find((e) => {
                    //     return e.bn === offsetBlock
                    //   })

                    const scheduleSlot = this.self.witness.witnessSchedule.find(e => e.in_past !== true)
                    
                    
                    const calc = calcBlockInterval({
                        currentBlock: this.self.chainBridge.hiveStream.currentBlock, 
                        intervalLength: this.multisigOptions.rotationIntervalHive,
                        marginLength: 5
                    })
                    
                    // console.log(calc)
                    const scheduleSlotActual = this.self.witness.witnessSchedule.find(e => e.bn === calc.last)

                    // console.log('scheduleSlotActual', scheduleSlotActual)

                    // console.log(this.self.chainBridge.hiveStream.currentBlock % this.multisigOptions.rotationIntervalHive, this.self.chainBridge.hiveStream.currentBlock)
                    if (nodeInfo.enabled && nodeInfo.trusted && calc.isMarginActive) {
                        if (!this._rotationRunning && calc.last !== this.lastRotateBlock) {
                            console.log('time to rotate mulitisig keys')
                            this._rotationRunning = true;
                            try {
                                await this.triggerKeyrotation()
                            } catch(ex) {
                                console.log(ex)
                            }
                            this.lastRotateBlock = calc.last
                            this._rotationRunning = false
                        }
                    }
                    const procOutCalc = calcBlockInterval({
                        currentBlock: this.self.chainBridge.hiveStream.currentBlock, 
                        intervalLength: 20,
                        marginLength: 5
                    })
                    // console.log(this.runnerTags, this.isTagged('process_outputs'), procOutCalc.last,  this.runnerTags['process_outputs']?.v)
                    // console.log(nodeInfo, this.self.witness.witnessSchedule.find(e => e.bn === procOutCalc.last), this.self.witness.witnessSchedule.find(e => e.bn === procOutCalc.last).account === nodeInfo.account)
                    if (
                      scheduleSlot &&
                      procOutCalc.isMarginActive &&
                      !this.isTagged('process_outputs') &&
                      procOutCalc.last !== this.runnerTags['process_outputs']?.v &&
                      this.self.witness.witnessSchedule.find((e) => e.bn === procOutCalc.last)
                        .account === nodeInfo.account 
                    ) {
                      // console.log('Processed on chain interactions', scheduleSlot)
                      try {
                        this.tagRunner('process_outputs')
                        this.tagValue('process_outputs', procOutCalc.last)
                        await this.processOutputs()
                        this.untagRunner('process_outputs')
                      } catch (ex) {
                        console.log(ex)
                      }
                    }
                }
            }
        }, 1.5 * 1000)
    }
}