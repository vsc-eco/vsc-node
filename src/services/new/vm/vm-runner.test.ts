
import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import fs from 'fs/promises'
import asc from "assemblyscript/dist/asc";
import * as IPFS from 'kubo-rpc-client'
import {fork} from 'child_process'
import Crypto from 'crypto'


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

    const binary = stdout.toBuffer()


    const cid = await ipfs.block.put(binary)
    console.log(cid)


    const parameters = [];
    const options = {
    stdio: [ 'pipe', 'pipe', 'pipe', 'ipc' ]
    };
    
    const partPath = path.join(__dirname, 'vm-runner.js').replace('src', 'dist')

    const child = fork(partPath, parameters, {
        env: {
            cid: cid.toString()
        } as any,
        detached: false
    });
    const pid = child.pid
    console.log(pid)
    child.send({
        
    });
    let reqId;
    let startTime
    child.on('message', (message: any) => {
        if(message.type === "ready") {
            reqId = Crypto.randomBytes(6).toString('base64url')
            startTime = new Date();
            console.log('startTime', startTime)
            const payload = JSON.stringify({
                to: "test1",
                from: 'test2',
            })
            child.send({
                type: "call",
                action: "testJSON",
                payload,
                reqId
            });
        }
        if(message.reqId === reqId) {
            console.log(message, new Date().getTime() - startTime.getTime(), new Date())
            reqId = Crypto.randomBytes(6).toString('base64url')
            startTime = new Date();
            const payload = JSON.stringify({
              to: "test1",
              from: 'test2',
            })
            child.send({
              type: "call",
              action: "testJSON",
              payload,
              reqId
          });
        }
    });

    // if(binary) {
    //     let dataStore = new Map()
    //     const insta = await instantiate(binary, {
    //         input: {
    //             consoleLog: (d) => {
                    
    //                 console.log('d', insta.exports.__getString(d))
    //                 // return 44
    //             },
    //             logNumber: (d) => {
    //                 console.log('logNumber', d)
    //             },
    //             logBool: (d) => {
    //                 console.log('logBool', d)
    //             },
    //             base64: () => {
    //               return base64
    //             },
    //             logUint8Array: (d) => {
    //                 console.log('logUint8Array', d)
    //             },
    //             "db.setObject": (keyPtr, valPtr) => {
    //                 const key = insta.exports.__getString(keyPtr)
    //                 const val = insta.exports.__getString(valPtr)
                    
    //                 console.log('setObject', key, val)
    //                 dataStore.set(key, val)
    //                 return 1;
    //             },
    //             "db.getObject": (key) => {
    //                 console.log('getObject', key)
    //                 return "hello"
    //             },
    //             api: async () => {
    //                 const { data } = await Axios.get('http://ipinfo.io/json')
    //                 console.log(data)
                    
    //                 return insta.exports.__newString(data.ip)
    //             }
    //         }
    //     } as any)

    // }
})()