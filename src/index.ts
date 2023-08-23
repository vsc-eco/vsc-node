import { ApiModule } from "./modules/api/index"
import { CoreService } from "./services"

async function startup(): Promise<void> {
  
  const core = new CoreService()
  await core.start()
  
  const api = new ApiModule(1337, core)
  await api.listen()
}

void startup()

process.on('unhandledRejection', (error: Error) => {
  console.log('unhandledRejection', error.message)
})
