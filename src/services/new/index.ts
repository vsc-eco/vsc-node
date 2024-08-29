import * as IPFS from 'kubo-rpc-client'
import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import winston from 'winston';
import { Collection, Db } from 'mongodb';
import { Config } from "../nodeConfig";
import { ChainBridgeV2 } from "./chainBridgeV2";
import { NodeIdentity } from "./nodeIdentity";
import { BlsDID, initBls } from "./utils/crypto/bls-did";
import { CoreService } from '..';
import { WitnessServiceV2 } from './witness';
import { getLogger } from '../../logger';
import { createMongoDBClient } from '../../utils';
import { TransactionPoolV2 } from './transactionPool';
import { P2PService } from './p2pService';
import { AddrRecord } from './types';
import { ContractEngineV2 } from './contractEngineV2';
import { VersionManager } from './witness/versionManager';
import { ElectionManager } from './witness/electionManager';
import { FileUploadManager } from './fileUploadManager';
import { Gauge } from 'prom-client';


export class NewCoreService {
    config: Config;
    consensusKey: BlsDID;
    chainBridge: ChainBridgeV2;
    nodeIdentity: NodeIdentity;
    ipfs: IPFS.IPFSHTTPClient;
    oldService: CoreService;
    witness: WitnessServiceV2;
    logger: winston.Logger;
    db: Db;
    transactionPool: TransactionPoolV2;
    p2pService: P2PService
    identity: DID;
    addrsDb: Collection<AddrRecord>;
    contractEngine: ContractEngineV2;
    miscDb: Collection;
    versionManager: VersionManager
    electionManager: ElectionManager
    fileUploadManager: FileUploadManager;
    nonceMap: Collection;
    nodeIdMetric = new Gauge({ name: 'node_id', help: 'Node id', labelNames: ['node_id'] });
    
    constructor() {
        this.config = new Config(Config.getConfigDir())
        this.logger = getLogger( {
            prefix: 'core',
            printMetadata: this.config.get('logger.printMetadata'),
            level: this.config.get('logger.level'),
        })
        this.ipfs = IPFS.create({url: process.env.IPFS_HOST || '/ip4/127.0.0.1/tcp/5001'})
        this.db = createMongoDBClient('new')

        
        this.chainBridge = new ChainBridgeV2(this)
        this.nodeIdentity = new NodeIdentity(this)
        this.witness = new WitnessServiceV2(this)
        this.p2pService = new P2PService(this)
        this.transactionPool = new TransactionPoolV2(this)
        this.contractEngine = new ContractEngineV2(this)
        this.versionManager = new VersionManager(this)
        this.electionManager = new ElectionManager(this)
        this.fileUploadManager = new FileUploadManager(this)
    }
    
    async init(oldService) {
        this.addrsDb = this.db.collection('addrs')
        this.miscDb = this.db.collection('misc')
        this.nonceMap = this.db.collection('nonce_map')

        this.oldService = oldService
        await this.config.open()
        await initBls();
        const privateKey = Buffer.from(this.config.get('identity.nodePrivate'), 'base64')
        this.consensusKey = BlsDID.fromSeed(privateKey)

        const keyPrivate = new Ed25519Provider(privateKey)
        const did = new DID({ provider: keyPrivate, resolver: KeyResolver.getResolver() })
        await did.authenticate()
        this.identity = did
        this.nodeIdMetric.reset();
        this.nodeIdMetric.labels(did.id).set(1)

        await this.versionManager.init()

        await this.chainBridge.init();
        await this.p2pService.start()
        await this.witness.init();
        await this.transactionPool.init()
        await this.contractEngine.init()
        await this.electionManager.init()
         
    }

    async start() {
        await this.chainBridge.start();
        console.log('running here')
        await this.nodeIdentity.start()
        await this.witness.start()
        await this.electionManager.start()
        await this.fileUploadManager.start()
    }

    async stop() {
        await this.fileUploadManager.stop()
    }
}