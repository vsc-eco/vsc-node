import * as IPFS from 'kubo-rpc-client'
import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import winston from 'winston';
import { Collection, Db } from 'mongodb';
import { Config } from "../nodeConfig";
import { ChainBridgeV2 } from "./chainBridgeV2";
import { NodeIdentity } from "./nodeIdentity";
import { BlsDID } from "./utils/crypto/bls-did";
import { CoreService } from '..';
import { WitnessServiceV2 } from './witness';
import { getLogger } from '../../logger';
import { createMongoDBClient } from '../../utils';
import { TransactionPoolV2 } from './transactionPool';
import { P2PService } from './p2pService';
import { AddrRecord } from './types';
import { ContractEngineV2 } from './contractEngineV2';

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
    
    constructor() {
        this.config = new Config(Config.getConfigDir())
        this.logger = getLogger( {
            prefix: 'core',
            printMetadata: this.config.get('logger.printMetadata'),
            level: this.config.get('logger.level'),
        })
        this.ipfs = IPFS.create({url: 'http://127.0.0.1:5001'})
        this.chainBridge = new ChainBridgeV2(this)
        this.nodeIdentity = new NodeIdentity(this)
        this.witness = new WitnessServiceV2(this)
        this.p2pService = new P2PService(this)
        this.transactionPool = new TransactionPoolV2(this)
        this.contractEngine = new ContractEngineV2(this)
    }
    
    async init(oldService) {
        this.db = createMongoDBClient('new')
       
        this.oldService = oldService
        await this.config.open()
        const privateKey = Buffer.from(this.config.get('identity.nodePrivate'), 'base64')
        this.consensusKey = BlsDID.fromSeed(privateKey)

        const keyPrivate = new Ed25519Provider(privateKey)
        const did = new DID({ provider: keyPrivate, resolver: KeyResolver.getResolver() })
        await did.authenticate()
        this.identity = did

        await this.chainBridge.init();
        await this.p2pService.start()
        await this.witness.init();
        await this.transactionPool.init()
        await this.contractEngine.init()

        this.addrsDb = this.db.collection('addrs')
    }

    async start() {
        await this.chainBridge.start();
        console.log('running here')
        await this.nodeIdentity.start()
    }

    async stop() {

    }
}