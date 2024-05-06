import { Operation, PrivateKey, Transaction } from "@hiveio/dhive";
import moment from 'moment'
import hive from '@hiveio/hive-js'
import * as HiveTx from 'hive-tx'

import { HiveClient, HiveClient2, calcBlockInterval } from "../../../utils";
import { NewCoreService } from "..";
import { WitnessServiceV2 } from ".";
import networks from "../../networks";
import { ParserFuncArgs } from "../utils";



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

const orderAlphabetically = (
    auths: [string, number][],
  ): [string, number][] => {
    const names = auths.map((auth) => auth[0]).sort();
    const sortedArr: [string, number][] = [];
    for (let i = 0; i < names.length; i++) {
      const index = auths.findIndex((e) => e[0] === names[i]);
      const element: [string, number] = [
        auths[index][0].toString(),
        auths[index][1],
      ];
      sortedArr.push(element);
    }
    return sortedArr;
  };

export class MultisigSystem {
    multisigOptions: { 
      //Multisig interval in hrs
      rotationInterval: number; 
    };
    self: NewCoreService;
    witness: WitnessServiceV2;
    epochLength: number;
    constructor(self: NewCoreService, witness: WitnessServiceV2) {

        this.self = self;
        this.witness = witness
        
        this.epochLength = 20 * (1 * 60) //1 hours
    }

    /**
     * Constucts a signable hive transaction with deterministic expiration ref_block_num and ref_block_prefix for a given block height.
     * 
     * @param operations 
     * @param block_height 
     * @param expiration Default of 300 seconds
     * @returns 
     */
    async constructHiveTx(operations: Operation[], block_height: number, expiration: number = moment.duration(30, 'minutes').asMilliseconds()): Promise<Transaction> {
        const bh = await HiveClient.database.getBlock(block_height)

        const timestamp = moment(new Date(bh.timestamp + 'Z'))

        return {
            ref_block_num: parseInt(bh.block_id.slice(0, 8), 16) & 0xffff,
            ref_block_prefix: Buffer.from(bh.block_id, 'hex').readUInt32LE(4),
            expiration: timestamp.add(expiration, 'millisecond').toISOString().slice(0, -5),
            operations: operations,
            extensions: []
        }
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

    
    async runKeyRotation(block_height: number) {
        // const consensusRound = await this.self.witness.calculateConsensusRound(block_height)

        const electionResult = await this.self.electionManager.getValidElectionOfblock(block_height)
        const members = electionResult.members


        const candidateNodes = []
        for(let member of members) { 
            const witness = await this.self.chainBridge.witnessDb.findOne({
                account: member.account
            })
            if(witness) {
                candidateNodes.push(witness)
            }
        }

        const ownerKeys = candidateNodes.map(e => e.signing_keys.owner)
        
        const multisigConf = createSafeDivision({factorMax: 11, factorMin: 6, map: candidateNodes})

        const [multisigAccount] = await HiveClient.database.getAccounts([networks[this.self.config.get('network.id')].multisigAccount])
       
        
        const transaction: Transaction = await this.constructHiveTx([
            ['account_update', {
                account: networks[this.self.config.get('network.id')].multisigAccount,
                owner: {
                    //Backup account for now. It will be removed in future versions
                    // account_auths: [['vsc.network', multisigConf.threshold]],
                    account_auths: [],
                    key_auths: orderAlphabetically(ownerKeys.map(e => [e, 1])),
                    
                    weight_threshold: multisigConf.threshold
                },
                active: {
                    account_auths: [],
                    key_auths: [],
                    
                    weight_threshold: multisigConf.threshold
                },
                posting: {
                    account_auths: [['vsc.network', multisigConf.threshold]],
                    key_auths: [],
                    
                    weight_threshold: multisigConf.threshold
                },
                memo_key: multisigAccount.memo_key,
                json_metadata: JSON.stringify({
                    message: "VSC Multsig Account",
                    epoch: electionResult.epoch
                })
            }]
        ], block_height)

        
        console.log(JSON.stringify(transaction, null, 2), ownerKeys, ownerKeys.length)
        if(transaction.operations[0][1].owner.key_auths.length < 3) { 
            return
        }
        //const hiveTxData = new HiveTx.Transaction(transaction)

        let signingKey;
        let pubKey = PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner')).createPublic().toString();
        console.log(pubKey)
        if(!!multisigAccount.owner.key_auths.map(e => e[0]).find(e => e === pubKey)){ 
            signingKey = PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner'))
        } else if(process.env.MULTISIG_STARTUP_OWNER) {
            signingKey = PrivateKey.fromString(process.env.MULTISIG_STARTUP_OWNER)
        } else {
            console.log('Error: No signing key found - Not in signing list')
            return;
        }

        const what = hive.auth.signTransaction({
            ...transaction
        }, [signingKey.toString()]);
        
        // console.log(what)
        // // const signedTx = await HiveClient.broadcast.sign(transaction, PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner')))
        // // console.log(JSON.stringify(signedTx, null, 2))

        const {drain} = await this.self.p2pService.multicastChannel.call('multisig.request_rotate', {
            payload: {
                block_height,
            },
            mode: 'stream',
            streamTimeout: 12000,
            responseOrigin: 'many'
        })
        const key_auths = multisigAccount.owner.key_auths.map(e => e[0])


        let signatures = [...what.signatures]
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
        

        what.signatures = signatures
        if(signatures.length >= multisigAccount.owner.weight_threshold) { 
            console.log('fully signed', what)
            try {
                const txConfirm = await HiveClient.broadcast.send(what)
                console.log(txConfirm)
            } catch (ex) {
                console.log(ex)
            }
        } else {
            console.log('not fully signed')
        }
    }
    
    async init() {
        this.self.p2pService.multicastChannel.register('multisig.request_rotate', async (data) => {
            const {message, drain} = data
            const block_height = message.block_height
            console.log('multisig.request_rotate - block_height', block_height)

            const electionResult = await this.self.electionManager.getValidElectionOfblock(block_height)
            const members = electionResult.members

            
            const candidateNodes = []
            for(let member of members) { 
                const witness = await this.self.chainBridge.witnessDb.findOne({
                    account: member.account
                })
                if(witness) {
                    candidateNodes.push(witness)
                }
            }

            const ownerKeys = candidateNodes.map(e => e.signing_keys.owner)

            const multisigConf = createSafeDivision({factorMax: 11, factorMin: 6, map: candidateNodes})

            const [multisigAccount] = await HiveClient.database.getAccounts([networks[this.self.config.get('network.id')].multisigAccount])
        
            
            const transaction: Transaction = await this.constructHiveTx([
                ['account_update', {
                    account: networks[this.self.config.get('network.id')].multisigAccount,
                    owner: {
                        //Backup account for now. It will be removed in future versions
                        account_auths: [],
                        key_auths: orderAlphabetically(ownerKeys.map(e => [e, 1])),
                        
                        weight_threshold: multisigConf.threshold
                    },
                    active: {
                        account_auths: [],
                        key_auths: [],
                        
                        weight_threshold: multisigConf.threshold
                    },
                    posting: {
                        account_auths: [['vsc.network', multisigConf.threshold]],
                        key_auths: [],
                        
                        weight_threshold: multisigConf.threshold
                    },
                    memo_key: multisigAccount.memo_key,
                    json_metadata: JSON.stringify({
                        message: "VSC Multsig Account",
                        epoch: electionResult.epoch
                    })
                }]
            ], block_height)


            //Fix issues with rotated keys after 
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
                
            /*let pubKey = PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner')).createPublic().toString();
            console.log(pubKey)
            if(!!{ 
                signingKey = PrivateKey.fromString(this.self.config.get('identity.signing_keys.owner'))
            } else if(process.env.MULTISIG_STARTUP_OWNER) {
                
            } else {
                
            }*/


            const signedTx = hive.auth.signTransaction({
                ...transaction
            }, [signingKey.toString()]);
            
            drain.push({
                signature: signedTx.signatures[0]
            })
        }, {
            loopbackOk: true
        })
        await this.self.chainBridge.streamParser.addParser({
            type: "block",
            priority: "after",
            func: async (data: ParserFuncArgs<'block'>) => { 
                const block = data.data
                const block_height = Number(block.key)

                if(block_height % this.epochLength === 0 && this.self.chainBridge.parseLag < 5) {
                    const slotInfo = await this.self.witness.calculateConsensusRound(block_height)
                    const schedule = await this.self.witness.getBlockSchedule(block_height)
                    const slot = schedule.find(e => e.bn >= block_height)
                    
                    if(slot.account === process.env.HIVE_ACCOUNT) {
                        const limit = block_height % this.epochLength;
        
                        await this.runKeyRotation(block_height)
                    }
                }
            }
        })
    }

    async start() {

    }
}