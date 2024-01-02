
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import fs from 'fs/promises'
import asc from "assemblyscript/dist/asc";
import * as IPFS from 'kubo-rpc-client'
import {fork} from 'child_process'
import Crypto from 'crypto'
import { VmContainer } from './utils';
import { sleep } from '../../../utils';


const ipfs = IPFS.create({url: 'http://127.0.0.1:5001'})
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);



void (async () => {
    const scriptPath = path.join(__dirname, 'script.tsa')


    var stdout = asc.createMemoryStream();
    const compileResult = await asc.main([
      'input.ts',
      // "-b",
      "-o",
      "--optimize",
      "--Osize",
      "--exportRuntime",
      '--runPasses',
      "asyncify"
    ], {
      stdout: stdout,
     readFile: async (filename: string, baseDir: string) => {
        // console.log(filename, baseDir) 
        try {
          if(filename === 'input.ts') {
            return (await fs.readFile(scriptPath)).toString()
          }
          return (await fs.readFile(filename)).toString()
        } catch {
          return null
        }
      }
    });

    
    if(compileResult.error) {
        console.log(compileResult.error)
        console.log(compileResult.stderr.toString())
        return;
    }

    try {
      const binary = stdout.toBuffer()
  
  
      const cid = await ipfs.block.put(binary)
      console.log(cid)
  
      const vmContainer = new VmContainer({
        contract_id: 'vs41q9c3yg8estwk8q9yjrsu2hk6chgk5aelwlf8uj3amqfgywge8w3cul438q9tx556',
        cid: cid.toString()
      })
  
      await vmContainer.init()
      await vmContainer.onReady()
  
  
      for(let x = 0; x < 1; x++) {
        const result = await vmContainer.call({
          action: 'testJSON',
          payload: JSON.stringify({
            to: "test1",
            from: 'test2',
          })
        })
        console.log(result)
      }    
          
      await vmContainer.finish()
    } catch(ex) {
      console.log(ex)
    }

    process.exit(0)

    let reqId;
    let startTime
    // child.on('message', (message: any) => {
    //     if(message.type === "ready") {
    //         reqId = Crypto.randomBytes(6).toString('base64url')
    //         startTime = new Date();
    //         console.log('startTime', startTime)
    //         const payload = JSON.stringify({
    //             to: "test1",
    //             from: 'test2',
    //         })
    //         child.send({
    //             type: "call",
    //             action: "testJSON",
    //             payload,
    //             reqId
    //         });
    //     }
    //     if(message.reqId === reqId) {
    //         console.log(message, new Date().getTime() - startTime.getTime(), new Date())
    //         reqId = Crypto.randomBytes(6).toString('base64url')
    //         startTime = new Date();
    //       //   const payload = JSON.stringify({
    //       //     to: "test1",
    //       //     from: 'test2',
    //       //   })
    //       //   child.send({
    //       //     type: "call",
    //       //     action: "testJSON",
    //       //     payload,
    //       //     reqId
    //       // });
    //     }
    // });
})()