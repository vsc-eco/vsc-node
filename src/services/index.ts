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
import networks from "./networks";
interface CoreOptions {
    dbSuffix?: string

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
    p2pService: P2PService;
    contractWorker: ContractWorker;
    logger: winston.Logger;
    loggerSettings: LoggerConfig;
    // multisig: MultisigCore;
    nodeInfo: NodeInfoService;
    witness: WitnessService;
    networkId: any;
    multisig: MultisigCore;

    constructor(loggerSettings?: LoggerConfig) {}

    private async setupKeys() {
        let keyBackup = {}
        let noBackup = false;
        let keyBackupPath = Path.join(this.getConfigDir, '.vsc-seed-backup.json')

        //Check if identity already exists, if not load keybackup if exists
        try {
            await fs.stat(keyBackupPath)
            if(this.config.get(`identity`)) {
                try {
                    const data = await fs.readFile(keyBackupPath)
                    keyBackup = JSON.parse(data.toString());
                } catch {
    
                }
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

    get getConfigDir(): string {
        return this.config.get('setupIdentification.configSuffix') !== '' ? Path.join(os.homedir(), '.vsc-node-' + this.config.get('setupIdentification.configSuffix')) : Path.join(os.homedir(), '.vsc-node')
    }

    async dropTables() {
        const collections = [
            'state_headers',
            'block_headers',
            'witnesses',
            'account_balances',
            'contract_balances',
            'account_balance_operations',
            'contract_balance_operations',
            'contracts',
            'contract_commitment',
            'contract_log',
            'node_status',
            'peers',
            'transaction_pool',
            'block_headers'
        ]

        for(let collection of collections) {
            await this.db.collection(collection).deleteMany({})
        }
    }

    async start() {
        console.log('Starting')
        this.ipfs = IPFSHTTP.create({ url: process.env.IPFS_HOST || this.config.get('ipfs.apiAddr')});
        this.config = new Config(this.getConfigDir)
        await this.config.open()
        this.networkId = this.config.get('network.id')
        this.logger = getLogger(this.loggerSettings || {
            prefix: 'core',
            printMetadata: this.config.get('logger.printMetadata'),
            level: this.config.get('logger.level'),
        })
        this.db = this.config.get('setupIdentification.dbSuffix') !== '' ? mongo.db('vsc-' + this.config.get('setupIdentification.dbSuffix')) : mongo.db('vsc')
        await mongo.connect()
        if (this.config.get('debug.dropTablesOnStartup')) {
            await this.dropTables();
        }     

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