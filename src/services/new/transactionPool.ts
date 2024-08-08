import { Collection } from "mongodb";
import { NewCoreService } from ".";
import { MessageHandleOpts } from "./p2pService";
import { SignatureType, TransactionContainerV2, TransactionDbRecordV2, TransactionDbStatus, TransactionDbType } from "./types";
import { HiveClient, sleep } from "../../utils";
import { PrivateKey } from "@hiveio/dhive";
import { encodePayload } from 'dag-jose-utils'
import { CID } from "kubo-rpc-client";
import { computeKeyId, verifyTx } from "./utils";
import { convertEIP712Type } from "@vsc.eco/client/dist/utils";
import * as DagCbor from '@ipld/dag-cbor'
import NodeSchedule from 'node-schedule'
import {recoverTypedDataAddress, hashTypedData} from 'viem'
import { AccountId } from "caip";
import { DID, DagJWS, GeneralJWS } from "dids";
import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher, sha256 } from 'multiformats/hashes/sha2'
import {recover} from 'web3-eth-accounts'
import pkg from 'bloom-filters';
import Moment from 'moment'

const { BloomFilter } = pkg;



interface TxAnnounceMsg {
    //ref_tx = only CID of TX useful for TXs under 2kb
    //direct_tx entire TX data
    type: "ref_tx" | 'direct_tx'
    payload: any | CID
}

const CONSTANTS = {
    //Maximum size of directly broadcasting tx over pubsub. 
    //Instead of only CID
    //For large TXs CID ref should be used instead to prevent flooding network
    //TXs over pubsub direct are faster and incurr less receive latency.
    //Delivery is guaranteed.
    max_broadcast_size: 8_000
}

type SigJWS = {
    t: undefined
    alg: string
    kid: string
    sig: Buffer
}

type SigEIP191 = {
    t: 'eip191',
    s: string
}

type Sig = SigJWS |  SigEIP191

async function convertSigToJWS(txCid: CID, sigVal): Promise<DagJWS> {

    return {
        payload: Buffer.from(txCid.bytes).toString('base64url'),
        signatures: [
            {
                protected: Buffer.from(JSON.stringify({
                    alg: sigVal.alg,
                    kid: [sigVal.kid, sigVal.kid.split(':')[2]].join('#')
                })).toString('base64url'),
                signature: sigVal.sig
            }
        ],
        //dids library is using bad type for CID
        link: txCid as any
    }
}



async function verifyTxSignature(did: DID, tx: string, sig: string): Promise<[
    boolean,
    string?
]> {

    //Decode TX
    const txBuf = Buffer.from(tx, 'base64url')
    const decodedTx = DagCbor.decode(txBuf) as TransactionContainerV2
    const hash = await sha256.digest(txBuf)
    const txCid = CID.create(1, codec.code, hash)

    //Decode sig
    const sigBuf = Buffer.from(sig, 'base64url')
    const sigDecoded = DagCbor.decode(sigBuf) as {
        __t: 'vsc-sig',
        sigs: Sig[]
        eip712_type?: object
    }
    
    for(let sig of sigDecoded.sigs) {
        //Check if equal to eip191, OR leave as undefined for JWS suport
        const recoveredAuths = []
        if(sig.t === 'eip191') {
            //Verify via EIP191 

            const typedData = sigDecoded.eip712_type || convertEIP712Type(decodedTx)

            const signature = (sig as SigEIP191).s
            const hash = hashTypedData({
                ...typedData as any,
                message: decodedTx
            })

            //0xHex64bytes
            const addressMetamask = await recoverTypedDataAddress({
                ...typedData,
                message: decodedTx,
                //as any because it wants 0x string type
                signature
            } as any)
            const address = recover(hash, signature)

            const resolveAddresses = [address, addressMetamask]

            //Filter for relevant DID auths
            const filteredAuths = decodedTx.headers.required_auths.map(e => { 
                return e.split('?')[0]
            }).filter(e => { 
                return e.startsWith('did:pkh:eip155')
            })

            const evmAddresses = filteredAuths.map(e => { 
                return AccountId.parse(e.replace('did:pkh:', '')).address
            })
            console.log('recoveredAuths', resolveAddresses, evmAddresses)

            //If not included in list of DID auths
            //There is a signing difference between Metamask and direct private key signing
            //This is a temporary workaround until further investigate is done.
            //For now, this will support for metamask and direct private key signing
            let resolvAddr;
            for(let addr of resolveAddresses) {
                const idx = evmAddresses.indexOf(addr)
                if(idx !== -1) {
                    resolvAddr = evmAddresses[idx]
                    break
                }
            }
            
            if(!resolvAddr) { 
                return [false, "INCORRECT_SIG"];
            }

            recoveredAuths.push(`did:pkh:eip155:1:${resolvAddr}`)
        } else {
            //Verify via JWS
            const formattedJws = await convertSigToJWS(txCid, sig as SigJWS)
            console.log('Verifying signature', formattedJws)
            //No longer needed as JWS is reconstructed
            // if(formattedJws.payload !== Buffer.from(cid.bytes).toString('base64url')) {
            //     return false;
            // }
            let signedDid;
            try {
                const verifyResult = await did.verifyJWS(formattedJws)
        
                signedDid = verifyResult.kid.split('#')[0]
            } catch (ex) {
                console.log(ex)
                return [false, "INCORRECT_SIG"];
            }
        
            if(!decodedTx.headers.required_auths.map(e => {
                //Ensure there is no extra query fragments
                return e.split('?')[0]
            }).includes(signedDid) && !(decodedTx.headers.payer === signedDid)) {
                return [false, "WRONG_AUTH"]
            }

            recoveredAuths.push(signedDid)
        }
        for(let signer of decodedTx.headers.required_auths) {
            console.log('recoveredAuths, signer', recoveredAuths, signer)
            if(!recoveredAuths.includes(signer)) {
                return [false, "MISSING_AUTH"]
            }
        }
    }
    return [true];
}

export class TransactionPoolV2 {
    self: NewCoreService;
    txDb: Collection<TransactionDbRecordV2>
    nonceMap: Collection<{
        id: string
        nonce: number
    }>
    rejectFilter: pkg.BloomFilter;
    constructor(self: NewCoreService) {
        this.self = self

        this.blockParser = this.blockParser.bind(this)
        this.onTxAnnounce = this.onTxAnnounce.bind(this)


        this.rejectFilter = new BloomFilter(32 * 1024 * 8, 16)
    }

    /**
     * Runs when "announce_tx" is broadcasted on the P2P channels
     * @todo cleanup and DRY out signature validation logic.
     * @param param0 
     * @returns 
     */
    async onTxAnnounce({message}: MessageHandleOpts) {
        let decodedTx;
        let rawTx: Uint8Array;
        let tx_id;
        let sig_data = message.sig_data; //Must always be defined
        if(message.type === 'ref_tx') {
            tx_id = message.id
            rawTx = (await this.self.ipfs.block.get(tx_id))
            decodedTx = DagCbor.decode(rawTx)
        } else if(message.type = 'direct_tx') {
            rawTx = Buffer.from(message.data, 'base64url');
            decodedTx = DagCbor.decode(rawTx)
            tx_id = (await this.self.ipfs.block.put(rawTx, {
                pin: false,
                format: 'dag-cbor'
            })).toString()
        } else {
            return;
        }
        const txRecord = await this.txDb.findOne({
            id: tx_id
        })
        if(this.rejectFilter.has(tx_id)) {
            // console.log('HIT filter', tx_id)
            return;
        } else {
            //Verify nonce is valid
            const nonceEntry = await this.nonceMap.findOne({
                id: await computeKeyId(decodedTx.headers.required_auths)
            })
            if(nonceEntry) {
                //Invalid nonce, reject transaction and add to filter
                if(nonceEntry.nonce > decodedTx.headers.nonce) {
                    // console.log('INVALID TX: adding to filter', tx_id)
                
                    this.rejectFilter.add(tx_id)
                    return; 
                }
            }
        }
        if(!txRecord) { 
            if(!sig_data) {
                return;
            }
            //Run validation pipeline!
            const cid = await CID.parse(tx_id)
        
            const [isValidSig] = await verifyTxSignature(this.self.identity, Buffer.from(rawTx).toString('base64url'), sig_data)

            if(isValidSig === false) { 
                return false;
            }

            
           
            //TODO: Do nonce validation

            await this.txDb.insertOne({
                id: cid.toString(),
                status: TransactionDbStatus.unconfirmed,
                headers: {
                    nonce: decodedTx.headers.nonce,
                    type: decodedTx.headers.type,
                },
                required_auths: decodedTx.headers.required_auths.map(e => {
                    const [value, query] = e.split('?')
                    return {
                        value,
                    }
                }),
                data: decodedTx.tx,
                sig_hash: (await this.self.ipfs.block.put(Buffer.from(sig_data, 'base64url'), {
                    format: 'dag-cbor'
                })).toString(),
                src: 'vsc',
                first_seen: new Date(),
                local: true,
                accessible: true
            })
        }
    }

    /**
     * Ingests TX into DB
     */
    async ingestTx(args: {
        tx: string,
        //Raw sig data
        sig: string
        broadcast?: boolean
    }) {
        if(typeof args.broadcast === 'undefined') {
            //default to broadcast yes
            args.broadcast = true
        }

       
        const buf = Buffer.from(args.tx, 'base64url')
       

        const hash = await sha256.digest(buf)
        const cid = CID.create(1, codec.code, hash)
        const decodedTx = DagCbor.decode(buf) as TransactionContainerV2
    
        

        const [isValidSig, sigError] = await verifyTxSignature(this.self.identity, args.tx, args.sig)

        if(isValidSig === false) { 
            if(sigError === "INCORRECT_SIG") {
                throw new Error('Invalid Signature')
            } else if(sigError === "WRONG_AUTH") { 
                throw new Error('Incorrectly signed by wrong authority. Not included in "required_auths"')
            } else if(sigError === "MISSING_AUTH") {
                throw new Error('Missing required authority')
            } else {
                throw new Error('Unknown Signature Validation Error')
            }
        }

        if(typeof decodedTx.headers.nonce !== 'number') {
            throw new Error('Missing Nonce')
        }

        const nonceMap = (await this.nonceMap.findOne({
            id: await computeKeyId(decodedTx.headers.required_auths)
        })) || {nonce: 0}

        if(nonceMap.nonce > decodedTx.headers.nonce) {
            throw new Error('Invalid Nonce')
        }



        //TODO: Do nonce validation
        const txRecord = await this.txDb.findOne({
            id: cid.toString()
        })
        if(!txRecord) { 
            await this.txDb.insertOne({
                id: cid.toString(),
                status: TransactionDbStatus.unconfirmed,
                headers: {
                    nonce: decodedTx.headers.nonce,
                    type: decodedTx.headers.type,
                },
                required_auths: decodedTx.headers.required_auths.map(e => {
                    const [value, query] = e.split('?')
                    return {
                        value,
                    }
                }),
                data: decodedTx.tx,
                sig_hash: (await this.self.ipfs.block.put(Buffer.from(args.sig, 'base64url'), {
                    format: 'dag-cbor'
                })).toString(),
                src: 'vsc',
                first_seen: new Date(),
                local: true,
                accessible: true
            })
        }
        await this.self.ipfs.block.put(buf, {
            format: 'dag-cbor'
        })

        
        if(buf.length > CONSTANTS.max_broadcast_size) {
            //Over broadcast limit
            await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                payload: {
                    type: 'ref_tx',
                    id: cid.toString(),
                    //Fill in
                    sig_data: args.sig
                },
                mode: 'basic'
            })
        } else {
            await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                payload: {
                    type: 'direct_tx',
                    data: buf.toString('base64url'),
                    //Fill in
                    sig_data: args.sig
                },
                mode: 'basic'
            })
        }


        return {
            id: cid.toString()
        }
    }

    /**
     * Creates a demo TX for testing purposes
     */
    async createDummyTx(opts: {
        where: 'onchain' | 'offchain'
    }) {
        if(opts.where === 'onchain')  {
            const broadcast = await HiveClient.broadcast.json({
                required_auths: [],
                required_posting_auths: [process.env.HIVE_ACCOUNT],
                id: 'vsc.announce_tx',
                json: JSON.stringify({
                    net_id: this.self.config.get('network.id'),
                    data: {
                        op: 'dummy_tx',
                        action: 'dummy_tx',
                        payload: 'test-test'
                    }
                })
            }, PrivateKey.fromString(process.env.HIVE_ACCOUNT_POSTING))

            return broadcast;
        } else if(opts.where === 'offchain') {
            // const dataObj = {
            //     hello: "world"
            // }
            const currentBlock = await HiveClient.blockchain.getCurrentBlockNum()
            const partialData = {
                // ...dataObj,
                __t: 'vsc-tx',
                __v: '0.2',
                tx: { 
                    op: "null",
                    payload: 'test',
                },
                headers: {
                    type: TransactionDbType.null,
                    lock_block: currentBlock + 20 * 15,
                },
                required_auths: [
                    // {
                    //     // type: "posting",
                    //     value: this.self.identity.id
                    // }
                    this.self.identity.id
                ]
            } as any
            const result = await this.self.identity.createDagJWS(partialData)
            console.log(result)
            partialData.signatures = result.jws.signatures.map(e => {
                console.log(Buffer.from(e.protected, 'base64').toString())
                return {
                    t: SignatureType.JWS,
                    p: e.protected,
                    s: e.signature
                }
            })
            console.log(partialData)
            const cid = await this.self.ipfs.dag.put(partialData)
            console.log(await this.self.ipfs.block.stat(cid))
        } else {
            throw new Error('Invalid opts.where')
        }
    }

    /**
     * Cleans invalid transactions/expired transactions
     * TODO: in the future this should be done automatically after each new block
     * For now we can just do this lazily
     */
    async transactionCleaner() {
        const unconfirmedTxs = await this.txDb.find({ 
            status: TransactionDbStatus.unconfirmed,
            //Assume if transaction is not included within 1 hour that it is invalid
            //And should be dropped (assuming it actually is invalid)
            first_seen: {
                $lt: Moment().subtract(1, 'hour').toDate()
            }
        }).toArray()

        //Gather nonces to invalidate
        let nonceMap: Record<string, number> = {}
        for(let tx of unconfirmedTxs) { 
            const keyId = await computeKeyId(tx.required_auths.map(e => e.value));
            nonceMap[keyId] = ((await this.nonceMap.findOne({
                id: keyId
            })) || {nonce: 0}).nonce
        }

        // const currentBlock = await HiveClient.blockchain.getCurrentBlockNum()
        for(let tx of unconfirmedTxs) {
            //TODO: Diagram expire_block logic
            // if(!!tx.headers.expire_block && tx.headers.expire_block < currentBlock) {
            //     await this.txDb.deleteOne({ 
            //         id: tx.id
            //     })
            //     continue;
            // }
            
            const keyId = await computeKeyId(tx.required_auths.map(e => e.value));
            if(tx.headers.nonce < nonceMap[keyId]) {
                await this.txDb.deleteOne({ 
                    id: tx.id
                })
                this.rejectFilter.add(tx.id)
                this.self.ipfs.pin.rm(CID.parse(tx.id)).catch(() => {})
                this.self.ipfs.pin.rm(CID.parse(tx.sig_hash)).catch(() => {})
                
                await sleep(100)

                continue;
            }

        }

    }

    /**
     * Hive block parser for TX pool
     * @param args 
     * @returns 
     */
    protected async blockParser(args) {
        try {

             
            const {tx, blkHeight} = args.data

            for(let i = 0; i < tx.operations.length; i++) {
                const [op, opBody] = tx.operations[i]
                if(op === 'custom_json') {
                    // console.log('picked up TX', tx, fullTx)
                    if(opBody.id === 'vsc.announce_tx' || opBody.id === 'vsc.tx') {
                        const json = JSON.parse(opBody.json)
            
                        if(json.net_id !== this.self.config.get('network.id')) {
                            continue;
                        }
            
                        const required_auths = []
                        required_auths.push(...opBody.required_posting_auths.map(e => {
                            return `${e}?type=posting`
                        }))
                        required_auths.push(...opBody.required_auths.map(e => {
                            return `${e}?type=active`
                        }))
                        const txData = {
                            status: TransactionDbStatus.included,
                            id: `${tx.transaction_id}-${i}`,
                            required_auths,
                            anchored_height: blkHeight,
                            anchored_index: tx.index,
                            anchored_op_index: i,
                            headers: {
                                // lock_block: fullTx.block_height + 120,
                                type: json.tx.type
                            },
                            data: {
                                contract_id: json.tx.contract_id,
                                op: json.tx.op,
                                payload: json.tx.payload,
                                action: json.tx.action,
                            },
                            result: null,
                            local: false,
                            first_seen: new Date(),
                            accessible: true,
                            src: "hive" as any,
                        }
                        await this.txDb.findOneAndUpdate({
                            id: `${tx.transaction_id}-${tx.index}`,
                        }, {
                            $set: txData
                        }, {
                            upsert: true
                        })
                    }
                }
            }
        } catch (ex) {
            console.log(ex)
        }
    }
    
    async init() {
        this.txDb = this.self.db.collection('transaction_pool')
        this.nonceMap = this.self.db.collection('nonce_map')

        try {
            await this.txDb.createIndex(
                {
                    id: 1,
                },
                {
                    unique: true,
                },
            )
        } catch {}

        try {

            await this.nonceMap.createIndex({
                id: 1
            }, {
                unique: true
            })
        } catch {

        }

        // this.self.chainBridge.registerTickHandle('tx_pool.processTx', this.tickHandle, {
        //     type: 'tx',
        //     priority: 'before'
        // })
        this.self.chainBridge.streamParser.addParser({
            name: "tx-pool",
            type: 'tx',
            priority: 'before',
            func: this.blockParser
        })
        this.self.p2pService.memoryPoolChannel.register('announce_tx', this.onTxAnnounce, {
            loopbackOk: true
        })
        NodeSchedule.scheduleJob('*/5 * * * *', async () => { 
            const unconfirmedTxs = await this.txDb.aggregate([
                {
                    $match: {
                        status: TransactionDbStatus.unconfirmed
                    }
                },
                {
                    $sample: {
                        size: 25
                    }
                }
            ]).toArray()
    
            for(let tx of unconfirmedTxs) {
                await this.self.p2pService.memoryPoolChannel.call('announce_tx', {
                    payload: {
                        type: 'direct_tx',
                        data: Buffer.from(await this.self.ipfs.block.get(CID.parse(tx.id))).toString('base64url'),
                        //Fill in
                        sig_data: Buffer.from(await this.self.ipfs.block.get(CID.parse(tx.sig_hash))).toString('base64url')
                    },
                    mode: 'basic'
                })
            }
        })
        //Do every 15 minutes
        NodeSchedule.scheduleJob('*/15 * * * *', async () => { 
            await this.transactionCleaner()
        })
    }

    async start() {

    }
}