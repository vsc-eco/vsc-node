import { ApiModule } from "./modules/api/index"
import { CoreService } from "./services"
import { NewCoreService } from "./services/new";

async function startup(): Promise<void> {
  
  const coreNew = new NewCoreService();
  const core = new CoreService({
    newService:coreNew
  })
  await core.start()

  await coreNew.init()
  await coreNew.start()
  
  const api = new ApiModule(1337, core)
  await api.listen()
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error)
})
