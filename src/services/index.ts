import { CID, IPFSHTTPClient } from "kubo-rpc-client";
import * as IPFSHTTP from "kubo-rpc-client";
import Path from 'path'
import Crypto from 'crypto'
import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import { Db } from "mongodb";
import fs from 'fs/promises'
import { Config } from "./nodeConfig";
import { mongo } from "./db";
import { ChainBridge } from "./chainBridge";
import { P2PService } from "./pubsub";
import winston from "winston";
import { getLogger } from "../logger";
import { LoggerConfig } from "../types";
import { PrivateKey } from "@hiveio/dhive";
import { MultisigCore } from "./witness/multisig";
import { NodeInfoService } from "./nodeInfo";
import { WitnessService } from "./witness";
import networks from "./networks";
import { DiscordBot } from "./discordbot";
import { createIPFSClient, ModuleContainer, createMongoDBClient } from "../utils";
import { NewCoreService } from "./new";
interface CoreOptions {
    dbSuffix?: string
    mode?: 'lite'
    newService?: NewCoreService
}

export class CoreService extends ModuleContainer {
    ipfs: IPFSHTTPClient;
    config: Config;
    identity: DID;
    wallet: DID;
    db: Db;
    chainBridge: ChainBridge;
    p2pService: P2PService;
    logger: winston.Logger;
    loggerSettings: LoggerConfig;
    // multisig: MultisigCore;
    nodeInfo: NodeInfoService;
    witness: WitnessService;
    networkId: any;
    multisig: MultisigCore;
    discordBot: DiscordBot;
    mode: string;
    modules: any[];
    newService: NewCoreService

    constructor(coreSettings?: LoggerConfig & CoreOptions) {
        super('core')
        this.mode = coreSettings?.mode
        this.newService = coreSettings.newService



        this.chainBridge = new ChainBridge(this)
        // this.contractWorker = new ContractWorker(this)
        this.p2pService = new P2PService(this)
        this.nodeInfo = new NodeInfoService(this)
        this.witness = new WitnessService(this)
        this.multisig = new MultisigCore(this, this.witness)
        this.discordBot = new DiscordBot(this)


        this.regModule('ChainBridge', this.chainBridge)
        // this.regModule('ContractWorker', this.contractWorker)
        this.regModule('P2PService', this.p2pService)
        this.regModule('NodeInfoService', this.nodeInfo)
        this.regModule('WitnessService', this.witness)
        this.regModule('MultisigCore', this.multisig)
        this.regModule('DiscordBot', this.discordBot)

        this.regNames()
    }

    private async setupKeys() {
        let keyBackup = {}
        let noBackup = false;
        let keyBackupPath = Path.join(Config.getConfigDir(), '.vsc-seed-backup.json')

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

    async dropTables() {
        const collections = [
            'state_headers',
            'block_headers',
            'witnesses',
            'balances',
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
        this.config = new Config(Config.getConfigDir())
        await this.config.open()
        this.ipfs = createIPFSClient({ url: process.env.IPFS_HOST || this.config.get('ipfs.apiAddr')}, this.config.get('ipfs.pinEverything'));
        this.networkId = this.config.get('network.id')
        this.logger = getLogger(this.loggerSettings || {
            prefix: 'core',
            printMetadata: this.config.get('logger.printMetadata'),
            level: this.config.get('logger.level'),
        })
        this.db = createMongoDBClient(this.config.get('setupIdentification.dbSuffix'))
        await mongo.connect()
        if (this.config.get('debug.dropTablesOnStartup')) {
            await this.dropTables();
        }     

        await this.setupKeys();

        

        const startStack = await this.startModules()
        console.log(`Startup complete with ${startStack.length} exceptions`)

    }

    async stop() {

    }
}