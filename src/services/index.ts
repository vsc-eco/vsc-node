import * as IPFS from "ipfs-http-client";
import { IPFSHTTPClient } from "ipfs-http-client";
import Path from 'path'
import os from 'os'
import Crypto from 'crypto'
import { Config } from "./nodeConfig";
import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import { TransactionPoolService } from "./transactionPool";
import { mongo } from "./db";
import { Db } from "mongodb";
import { ChainBridge } from "./chainBridge";
//@ts-ignore
import type { CeramicClient } from "@ceramicnetwork/http-client";
import { ContractEngine } from "./contractEngine";


export class CoreService {
    ipfs: IPFSHTTPClient;
    config: Config;
    identity: DID;
    wallet: DID;
    transactionPool: TransactionPoolService;
    db: Db;
    chainBridge: ChainBridge;
    ceramic: CeramicClient;
    contractEngine: ContractEngine

    async start() {
        this.ipfs = IPFS.create();
        this.config = new Config(Path.join(os.homedir(), '.vsc-node'))
        await this.config.open()
        this.db = mongo.db('vsc')
        await mongo.connect()

        for(let key of ['node', 'wallet']) {
            let privateKey = null
            if (this.config.get(`identity.${key}Private`)) {
              privateKey = Buffer.from(this.config.get(`identity.${key}Private`), 'base64')
            } else {
              privateKey = Crypto.randomBytes(32)
              const hex = privateKey.toString('base64')
              this.config.set(`identity.${key}Private`, hex)
              
            }
            const keyPrivate = new Ed25519Provider(privateKey)
            const did = new DID({ provider: keyPrivate, resolver: KeyResolver.getResolver() })
            await did.authenticate()
            this.config.set(`identity.${key}Public`, did.id)
            if(key === "node") {
                this.identity = did
            }
            if(key === "wallet") {
                this.wallet = did;
            }
        }

        const {CeramicClient} = await import('@ceramicnetwork/http-client')
        this.ceramic = new CeramicClient('https://ceramic.web3telekom.xyz')
        await this.ceramic.setDID(this.wallet)

        this.transactionPool = new TransactionPoolService(this)
        await this.transactionPool.start()
        
        this.chainBridge = new ChainBridge(this)
        await this.chainBridge.start();

        this.contractEngine = new ContractEngine(this)
        await this.contractEngine.start()
    }
}