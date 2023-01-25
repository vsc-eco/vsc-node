import { ApiModule } from "./modules/api/index"
import { CoreService } from "./services"


async function startup(): Promise<void> {
  const core = new CoreService()
  await core.start()
  console.log(`startup`)
  
  const api = new ApiModule(1337, core)
  await api.listen()

  // const coreSeconday = new CoreService({
  //   dbSuffix: '1',
  //   pathSuffix: '1',
  //   ipfsApi: "/ip4/127.0.0.1/tcp/5002"
  // })
  // await coreSeconday.start()
  console.log(`startup`)
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error.message)
})
