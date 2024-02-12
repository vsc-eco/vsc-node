import { PrivateKey, Transaction } from "@hiveio/dhive";
import moment from 'moment'
import hive from '@hiveio/hive-js'
import hiveTx from 'hive-tx'

import { HiveClient, HiveClient2, calcBlockInterval } from "../../../utils";
import { NewCoreService } from "..";
import { WitnessServiceV2 } from ".";



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

export class MultisigSystem {
    multisigOptions: { 
      //Multisig interval in hrs
      rotationInterval: string; 
    };
    self: NewCoreService;
    witness: WitnessServiceV2;
    constructor(self: NewCoreService, witness: WitnessServiceV2) {

        this.self = self;
        this.witness = witness
        

        this.multisigOptions = {
            rotationInterval: '6'
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
        const consensusRound = await this.self.witness.calculateConsensusRound(block_height)
        const candidateNodes = await this.self.chainBridge.getWitnessesAtBlock(block_height)

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
        const transaction: Transaction = {
            ref_block_num: parseInt(bh.block_id.slice(0, 8), 16) & 0xffff,
            ref_block_prefix: Buffer.from(bh.block_id, 'hex').readUInt32LE(4),
            expiration: moment().add('60', 'seconds').toDate().toISOString().slice(0, -5),
            operations: [
                ['account_update', {
                    account: process.env.MULTISIG_ACCOUNT,
                    owner: {
                        account_auths: [['vaultec', multisigConf.threshold]],
                        key_auths: orderAlphabetically(ownerKeys.map(e => [e, 1])),
                        // key_auths: [...multisigAccount.owner.key_auths, ...(await candidateNodes).map(e => {
                        //     return [(e as any).signing_keys.owner,1]
                        // })],
                        
                        weight_threshold: multisigConf.threshold
                    },
                    active: {
                        account_auths: multisigAccount.owner.account_auths,
                        key_auths: orderAlphabetically(activeKeys.map(e => [e, 1])),
                        // key_auths: [...multisigAccount.owner.key_auths, ...(await candidateNodes).map(e => {
                        //     return [(e as any).signing_keys.owner,1]
                        // })],
                        
                        weight_threshold: multisigConf.threshold
                    },
                    posting: {
                        account_auths: multisigAccount.owner.account_auths,
                        key_auths: orderAlphabetically(postingKeys.map(e => [e, 1])),
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
        console.log(JSON.stringify(transaction, null, 2))
        
        const hiveTxData = new hiveTx.Transaction(transaction)
        
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


        let signatures = [...what.signatures]
        for await(let data of drain) {
          const {payload} = data
          console.log('sigData',signatures.length, payload, data)
          const nodeInfo = await this.self.chainBridge.witnessDb.findOne({
              peer_id: data.from.toString()
          })
          if(nodeInfo) {
              if(multisigAccount.owner.key_auths.map(e => e[0]).includes(nodeInfo.signing_keys.owner)) {
                  const pubKey = hiveTx.PublicKey.from(nodeInfo.signing_keys.owner)
      
                  if(pubKey.verify(hiveTxData.digest().digest, hiveTx.Signature.from(payload.signature))) {
                      if(multisigAccount.owner.weight_threshold <= signatures.length) {
                          break;
                      }
                      signatures.push(payload.signature)
                  }
              }
          }
        }
        

        what.signatures = signatures
        
        // // console.log('signature end', signatures, PrivateKey.from(this.self.config.get('identity.signing_keys.owner')).createPublic().toString())
        // // signedTx.signatures.push(...signatures)
        // // console.log(signedTx.signatures)
        console.log('fully signed', what)
        try {
            const txConfirm = await HiveClient2.broadcast.send(what)
            console.log(txConfirm)
        } catch (ex) {
            console.log(ex)
        }
        // hive.api.broadcastTransactionSynchronous(signedTx, function(err, result) {
        //     console.log(err, result);
        //   });
          
    }
    
    async init() {
        
    }

    async start() {

    }
}