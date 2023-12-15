import asc from "assemblyscript/dist/asc";
import loader from '@assemblyscript/loader'
import Axios from 'axios'
import fs from 'fs/promises'
import base64 from 'base-64'
import { sleep } from "../../../utils";
import { instantiate } from "./utils";




void (async () => {
    // loader.instantiate
    // const data = await asc.compileString({
    //   ['input.ts']: (await fs.readFile("./src/services/new/vm/script.ts")).toString(),
    //   ['~lib/assemblyscript-json/assembly.ts']: (await fs.readFile('node_modules/assemblyscript-json/assembly/index.ts')).toString(),
    //   ['~lib/assemblyscript-json/decoder.ts']: (await fs.readFile('node_modules/assemblyscript-json/assembly/decoder.ts')).toString(),
    //   ['~lib/assemblyscript-json/encoder.ts']: (await fs.readFile('node_modules/assemblyscript-json/assembly/encoder.ts')).toString(),
    //   ['~lib/assemblyscript-json/JSON.ts']: (await fs.readFile('node_modules/assemblyscript-json/assembly/JSON.ts')).toString(),
    //   ['~lib/assemblyscript-json/util.ts']: (await fs.readFile('node_modules/assemblyscript-json/assembly/util/index.ts')).toString(),
    //   ['~lib/assemblyscript-json/util/index.ts']: (await fs.readFile('node_modules/assemblyscript-json/assembly/util/index.ts')).toString(),
    // }, {
    //     // textFile
    //     // runtime: "esm"
    //     bindings: ['esm'],
    //     runPasses: ['asyncify'],
    //     lib: ['assemblyscript-json'],
    //     path: ['node_modules']
    // })

    var stdout = asc.createMemoryStream();
    const compileResult = await asc.main([
      'input.ts',
      // "-b",
      "-o",
      '--runPasses',
      "asyncify"
    ], {
      stdout: stdout,
     readFile: async (filename: string, baseDir: string) => {
        console.log(filename, baseDir) 
        try {
          if(filename === 'input.ts') {
            return (await fs.readFile("./src/services/new/vm/script.ts")).toString()
          }
          return (await fs.readFile(filename)).toString()
        } catch {
          return null
        }
      }
    });

    // console.log(compileResult)
    // console.log(compileResult.stderr.toString())
    const binary = stdout.toBuffer()
    console.log(stdout.toString())
    console.log(compileResult)
    // await fs.writeFile('debug.wat', stdout.toBuffer())
    console.log(compileResult.stderr.toString())
    // // console.log(data.text)
    // await fs.writeFile('debug2.wat', Buffer.from(data.text))
    console.log('total Size', binary.length)
    if(compileResult.error) {
      return;
    }
  // await sleep(15_000)
    if(binary) {
        let dataStore = new Map()
        const insta = await instantiate(binary, {
            input: {
                consoleLog: (d) => {
                    
                    console.log('d', insta.exports.__getString(d))
                    // return 44
                },
                logNumber: (d) => {
                    console.log('logNumber', d)
                },
                logBool: (d) => {
                    console.log('logBool', d)
                },
                base64: () => {
                  return base64
                },
                logUint8Array: (d) => {
                    console.log('logUint8Array', d)
                },
                "db.setObject": (keyPtr, valPtr) => {
                    const key = insta.exports.__getString(keyPtr)
                    const val = insta.exports.__getString(valPtr)
                    
                    console.log('setObject', key, val)
                    dataStore.set(key, val)
                    return 1;
                },
                "db.getObject": (key) => {
                    console.log('getObject', key)
                    return "hello"
                },
                api: async () => {
                    const { data } = await Axios.get('http://ipinfo.io/json')
                    console.log(data)
                    
                    return insta.exports.__newString(data.ip)
                }
            }
        } as any)
        const promise = (insta.instance.exports as any).testJSON()

        console.log('past promise')
        void (async () => {
          for  ( ; ;) {
            console.log('JS is still running')
            await sleep(1000)
          }
        })()
        console.log(insta.exports.__getString((await promise)))
        
        // console.log(await (insta.instance.exports as any).testString(insta.exports.__newString("hellos")))
        // console.log( (insta.instance.exports as any).test('hell'))
        // console.log(dataStore)
    }
})()
