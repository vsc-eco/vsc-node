import { CoreService } from './services'
import { BenchmarkContainer } from './utils'

const TRIAL_NUMBER = 10_000

void (async () => {
  const core = new CoreService()
  await core.start()
  console.log('Starting Benchmark')

  const func = async () => {
      const benchmarkContainer = new BenchmarkContainer()
      const startDate = new Date()
      const optsToRun = []
      for (let x = 0; x < TRIAL_NUMBER; x++) {
        optsToRun.push([
          {
            id: 'bafyreietntvizm42d25qd2ppnng6mf7jkxyxpsgnsicomnqxxfowdcfsr4',
            action: 'set',
            payload: {
              key: 'hello',
              value: Math.random(),
            },
          },
        ])
      }
      const output = await core.contractEngine.contractExecuteRaw(
        'kjzl6cwe1jw149ac8h7kkrl1wwah8jkrnam9ys5yci2vhssg05khm71tktdbcbz',
        optsToRun,
        {
          benchmark: benchmarkContainer.createInstance(),
        },
      )
      benchmarkContainer.table()
      const doneIn = new Date().getTime() - startDate.getTime()
      const persecond = TRIAL_NUMBER / (doneIn / 1000)
      console.table({
        ['Done in']: doneIn,
        ['Per second']: persecond,
        ['ms per OP']: 1000 / persecond,
      })
  }
  let promises = []
  for(let threadId = 0; threadId < 1; threadId++) {
    promises.push(func())
  }
  await Promise.all(promises)
})()
