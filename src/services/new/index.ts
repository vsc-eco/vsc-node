import * as IPFS from 'kubo-rpc-client'
import { Config } from "../nodeConfig";
import { ChainBridgeV2 } from "./chainBridgeV2";
import { NodeIdentity } from "./nodeIdentity";
import { BlsDID } from "./utils/crypto/bls-did";
import { CoreService } from '..';
import { WitnessServiceV2 } from './witness';
import { getLogger } from '../../logger';
import winston from 'winston';
import { createMongoDBClient } from '../../utils';
import { Db } from 'mongodb';

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
    }
    
    async init(oldService) {
        this.db =  createMongoDBClient('new')
       
        this.oldService = oldService
        await this.config.open()
        const privateKey = Buffer.from(this.config.get('identity.nodePrivate'),'base64')
        this.consensusKey = BlsDID.fromSeed(privateKey)
        await this.chainBridge.init();
        await this.witness.init();
        
        // console.log('config file', privateKey)
        // console.log(await this.consensusKey.signObject({
        //     message: 'kitchen'
        // }))
    }

    async start() {
        await this.chainBridge.start();
        console.log('running here')
        await this.nodeIdentity.start()
    }

    async stop() {

    }
}