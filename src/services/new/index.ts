import * as IPFS from 'kubo-rpc-client'
import { Config } from "../nodeConfig";
import { ChainBridgeV2 } from "./chainBridgeV2";
import { NodeIdentity } from "./nodeIdentity";
import { BlsDID } from "./utils/crypto/bls-did";

export class NewCoreService {
    config: Config;
    consensusKey: BlsDID;
    chainBridge: ChainBridgeV2;
    nodeIdentity: NodeIdentity;
    ipfs: IPFS.IPFSHTTPClient;
    
    constructor() {
        this.config = new Config(Config.getConfigDir())
        this.ipfs = IPFS.create({url: 'http://127.0.0.1:5001'})
        this.chainBridge = new ChainBridgeV2(this)
        this.nodeIdentity = new NodeIdentity(this)
    }
    
    async init() {
        await this.chainBridge.init();
        await this.config.open()
        const privateKey = Buffer.from(this.config.get('identity.nodePrivate'),'base64')
        this.consensusKey = BlsDID.fromSeed(privateKey)
        
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