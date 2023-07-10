import { CID, IPFSHTTPClient } from "ipfs-http-client";
import * as IPFSHTTP from "ipfs-http-client";
import Path from 'path'
import os from 'os'
import Crypto from 'crypto'
import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import { Db } from "mongodb";
import fs from 'fs/promises'
import { Config } from "./nodeConfig";
import { TransactionPoolService } from "./transactionPool";
import { mongo } from "./db";
import { ChainBridge } from "./chainBridge";
import { ContractEngine } from "./contractEngine";
import { P2PService } from "./pubsub";
import { ContractWorker } from "./contractWorker";
import winston from "winston";
import { getLogger } from "../logger";
import { LoggerConfig } from "../types";
import { PrivateKey } from "@hiveio/dhive";
import { MultisigCore } from "./witness/multisig";
import { NodeInfoService } from "./nodeInfo";
import { WitnessService } from "./witness";

interface CoreOptions {
    pathSuffix?: string
    dbSuffix?: string
    ipfsApi?: string
    debugHelper?: {
        nodePublicAdresses?: Array<string>,
        serviceName?: string
    }
}

export class CoreService {
    ipfs: IPFSHTTPClient;
    config: Config;
    identity: DID;
    wallet: DID;
    transactionPool: TransactionPoolService;
    db: Db;
    chainBridge: ChainBridge;
    contractEngine: ContractEngine;
    options: CoreOptions;
    p2pService: P2PService;
    contractWorker: ContractWorker;
    logger: winston.Logger;
    loggerSettings: LoggerConfig;
    // multisig: MultisigCore;
    nodeInfo: NodeInfoService;
    witness: WitnessService;

    constructor(options?: CoreOptions, loggerSettings?: LoggerConfig) {
        this.options = options || {};

        if(!this.options.ipfsApi) {
            this.options.ipfsApi = "/ip4/127.0.0.1/tcp/5001"
        }
        if(!this.options.debugHelper) {
            this.options.debugHelper = {}
            if (!this.options.debugHelper.nodePublicAdresses) {
                this.options.debugHelper.nodePublicAdresses = []
            }
        }
    }

    private async setupKeys() {
        let keyBackup = {}
        let noBackup = false;
        let keyBackupPath = this.options.pathSuffix ? Path.join(os.homedir(), '.vsc-seed-backup-' + this.options.pathSuffix) + ".json" : Path.join(os.homedir(), '.vsc-seed-backup.json')

        //Check if identity already exists, if not load keybackup if exists
        try {
            await fs.stat(keyBackupPath)
            if(this.config.get(`identity`)) {
                try {
                    const data = await fs.readFile(keyBackupPath)
                    keyBackup = JSON.parse(data.toString());
                } catch {
    
                }
                Path.join(os.homedir(), '.vsc-node-' + this.options.pathSuffix)
            }
        } catch {
            noBackup = true
        }
        

        for(let key of ['node', 'wallet']) {
            let privateKey = null
            if (this.config.get(`identity.${key}Private`) || keyBackup[key]) {
              privateKey = Buffer.from(this.config.get(`identity.${key}Private`) || keyBackup[key], 'base64')
            } else {
              privateKey = Crypto.randomBytes(32)
              const hex = privateKey.toString('base64')
              this.config.set(`identity.${key}Private`, hex)
            }
            if(!keyBackup[key]) {
                keyBackup[key] = privateKey.toString('base64')
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
            if(key === 'wallet') {
                this.config.set('identity.signing_keys.posting', PrivateKey.fromLogin(networks[this.networkId].multisigAccount, privateKey.toString(), 'posting').toString())
                this.config.set('identity.signing_keys.active', PrivateKey.fromLogin(networks[this.networkId].multisigAccount, privateKey.toString(), 'active').toString())
                this.config.set('identity.signing_keys.owner', PrivateKey.fromLogin(networks[this.networkId].multisigAccount, privateKey.toString(), 'owner').toString())
            }
        }
        if(noBackup === true) {
            try {
                await fs.writeFile(keyBackupPath, JSON.stringify(keyBackup))
            } catch {
    
            }
        }
    }

    

    async start() {
        console.log('Starting')
        this.ipfs = IPFSHTTP.create({url: process.env.IPFS_HOST || "/ip4/127.0.0.1/tcp/5001"});
        const homeDir = this.options.pathSuffix ? Path.join(os.homedir(), '.vsc-node-' + this.options.pathSuffix) : Path.join(os.homedir(), '.vsc-node')
        this.config = new Config(homeDir)
        await this.config.open()
        this.networkId = this.config.get('network.id')
        this.logger = getLogger(this.loggerSettings || {
            prefix: 'core ' + (this.options.debugHelper.serviceName ?? ''),
            printMetadata: this.config.get('logger.printMetadata'),
            level: this.config.get('logger.level'),
        })
        this.db = this.options.dbSuffix ? mongo.db('vsc-' + this.options.dbSuffix) : mongo.db('vsc')
        await mongo.connect()
        await this.setupKeys();

        console.log('Starting part way')
        try 
        {
            this.transactionPool = new TransactionPoolService(this)
            await this.transactionPool.start()
            
            this.chainBridge = new ChainBridge(this)
            await this.chainBridge.start();
    
            this.contractEngine = new ContractEngine(this)
            await this.contractEngine.start()
            
            this.contractWorker = new ContractWorker(this)
            await this.contractWorker.start()

            this.p2pService = new P2PService(this)
            await this.p2pService.start()

            this.nodeInfo = new NodeInfoService(this)
            await this.nodeInfo.start()

            this.witness = new WitnessService(this)
            await this.witness.start()

            this.multisig = new MultisigCore(this, this.witness)
            await this.multisig.start()
        }
        catch (err) {
            console.trace(err)
        }
    }
}