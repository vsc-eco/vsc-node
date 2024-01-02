import fs from 'fs/promises'
import asc from "assemblyscript/dist/asc";

interface CompileResult {
    binary: Uint8Array | null
    err: string | null
}

export async function compileAS(args: {
    scriptPath: string
}): Promise<CompileResult> {
    const {scriptPath} = args;

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
        return {
            err: compileResult.stderr.toString(),
            binary:  null
        }
    }

    const binary = stdout.toBuffer()

    return {
        binary,
        err: null
    }
}