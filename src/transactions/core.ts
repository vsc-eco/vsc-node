import 'dotenv/config'
import * as IPFS from "kubo-rpc-client";
import { IPFSHTTPClient } from "kubo-rpc-client";
import Path from 'path'
import os from 'os'
import Crypto from 'crypto'

import { Ed25519Provider } from "key-did-provider-ed25519";
import { DID } from "dids";
import KeyResolver from 'key-did-resolver'
import { Config } from "../services/nodeConfig";
import { getLogger } from '../logger';
import { createIPFSClient } from '../utils';

let identity = null;

export async function init() {
    
    const config = new Config(Config.getConfigDir())
    await config.open()

    const logger = getLogger({
        prefix: 'manual tx core',
        printMetadata: config.get('logger.printMetadata'),
        level: config.get('logger.level'),
    })
    
    const ipfsClient = createIPFSClient({ url: process.env.IPFS_HOST || config.get('ipfs.apiAddr')});

    const privateKey = config.get('identity.walletPrivate');
    if(!privateKey) {
        throw new Error("No identity found. Please initial a daemon")
    }
    const keyPrivate = new Ed25519Provider(Buffer.from(privateKey, 'base64'))
    const identity = new DID({ provider: keyPrivate, resolver: KeyResolver.getResolver() })
    await identity.authenticate()
    if(!process.env.HIVE_ACCOUNT_POSTING || !process.env.HIVE_ACCOUNT_POSTING) {
        throw new Error("No HIVE account found in .env file")
    }

    logger.info(`Logged In With ${identity.id} and ${process.env.HIVE_ACCOUNT} connected to ipfs gw: ${config.get('ipfs.apiAddr')}`)

    return {
        identity,
        config,
        ipfsClient,
        logger
    }
}