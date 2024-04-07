import * as Sentry from '@sentry/node'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

type Primitive = number | string | boolean | bigint | symbol | null | undefined

const errorHandler = (err) => {
  Sentry.captureException(err)
}

const FLUSH_INTERVAL = 60 * 1000

const flusher = () => Sentry.flush()

let flushInterval

export default {
  start() {
    Sentry.init({
      dsn: 'https://8997351a7510d343abfe7227b44b20d4@o4507035962179584.ingest.us.sentry.io/4507039719358464',
      integrations: [nodeProfilingIntegration()],
      // Performance Monitoring
      tracesSampleRate: 1.0, //  Capture 100% of the transactions
      // Set sampling rate for profiling - this is relative to tracesSampleRate
      profilesSampleRate: 1.0,
    })

    process.on('unhandledRejection', errorHandler)
    process.on('uncaughtException', errorHandler)
    flushInterval = setInterval(flusher, FLUSH_INTERVAL)
  },
  stop() {
    process.off('unhandledRejection', errorHandler)
    process.off('uncaughtException', errorHandler)
    clearInterval(flushInterval)
    return Sentry.close()
  },
  setUserId(id: string, username: string) {
    Sentry.getCurrentScope().setUser({ id, username })
  },
  captureMessage(msg: string, ignoreContext: boolean = true) {
    if (ignoreContext) {
      Sentry.runWithAsyncContext(() => {
        Sentry.captureMessage(msg)
      })
    } else {
      Sentry.captureMessage(msg)
    }
  },
  captureError(err: Error, ignoreContext: boolean = false) {
    if (ignoreContext) {
      Sentry.runWithAsyncContext(() => {
        Sentry.captureException(err)
      })
    } else {
      Sentry.captureException(err)
    }
  },
  captureEvent(eventId: string, info: Record<string, Primitive>, ignoreContext: boolean = true) {
    if (ignoreContext) {
      Sentry.runWithAsyncContext(() => {
        Sentry.captureMessage(eventId, { tags: info })
      })
    } else {
      Sentry.captureMessage(eventId, { tags: info })
    }
  },
}
