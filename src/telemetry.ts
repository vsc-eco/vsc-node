import * as Sentry from '@sentry/node'
import { getDynamicSamplingContextFromSpan, spanToTraceHeader } from '@sentry/core'
import { dynamicSamplingContextToSentryBaggageHeader } from '@sentry/utils'
import { nodeProfilingIntegration } from '@sentry/profiling-node'

type Primitive = number | string | boolean | bigint | symbol | null | undefined

const errorHandler = (err) => {
  Sentry.captureException(err)
}

const FLUSH_INTERVAL = 60 * 1000

const DISABLED = true

const flusher = () => Sentry.flush()

let flushInterval

type TraceInfo = {
  baggage: string
  sentryTrace: string
}

export default {
  start() {
    if (DISABLED) {
      return
    }
    Sentry.init({
      dsn: 'https://282dcbc06e2462f1f83ce8190894497e@sentry.vsc.eco/2',
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
    if (DISABLED) {
      return
    }
    process.off('unhandledRejection', errorHandler)
    process.off('uncaughtException', errorHandler)
    clearInterval(flushInterval)
    return Sentry.close()
  },
  setUserId(id: string, username: string) {
    if (DISABLED) {
      return
    }
    Sentry.getCurrentScope().setUser({ id, username })
  },
  captureMessage(msg: string, ignoreContext: boolean = true) {
    if (DISABLED) {
      return
    }
    if (ignoreContext) {
      Sentry.runWithAsyncContext(() => {
        Sentry.captureMessage(msg)
      })
    } else {
      Sentry.captureMessage(msg)
    }
  },
  captureError(err: Error, ignoreContext: boolean = false) {
    if (DISABLED) {
      return
    }
    if (ignoreContext) {
      Sentry.runWithAsyncContext(() => {
        Sentry.captureException(err)
      })
    } else {
      Sentry.captureException(err)
    }
  },
  captureEvent(eventId: string, info: Record<string, Primitive>, ignoreContext: boolean = true) {
    if (DISABLED) {
      return
    }
    if (ignoreContext) {
      Sentry.runWithAsyncContext(() => {
        Sentry.captureMessage(eventId, { tags: info })
      })
    } else {
      Sentry.captureMessage(eventId, { tags: info })
    }
  },
  captureTracedEvent(name: string, info: Record<string, Primitive>) {
    if (DISABLED) {
      return {
        traceInfo: {
          baggage: '',
          sentryTrace: '',
        },
        addMetadata(info: Record<string, Primitive>) {
          for (const [key, value] of Object.entries(info)) {
            span.setTag(key, value)
          }
        },
        finish() {
          span.end()
        },
      }
    }
    const span = Sentry.startInactiveSpan({ name, tags: info })
    const dynamicSamplingContext = getDynamicSamplingContextFromSpan(span)

    const baggage = dynamicSamplingContextToSentryBaggageHeader(dynamicSamplingContext)

    const traceInfo: TraceInfo = {
      baggage,
      sentryTrace: spanToTraceHeader(span),
    }

    return {
      traceInfo,
      addMetadata(info: Record<string, Primitive>) {
        for (const [key, value] of Object.entries(info)) {
          span.setTag(key, value)
        }
      },
      finish() {
        span.end()
      },
    }
  },
  continueTracedEvent(name: string, traceInfo: TraceInfo, info: Record<string, Primitive>) {
    if (DISABLED) {
      return {
        addMetadata(info: Record<string, Primitive>) {},
        finish() {},
      }
    }
    const span = Sentry.continueTrace(traceInfo, () => {
      return Sentry.startInactiveSpan({ name, tags: info })
    })

    return {
      addMetadata(info: Record<string, Primitive>) {
        for (const [key, value] of Object.entries(info)) {
          span.setTag(key, value)
        }
      },
      finish() {
        span.end()
      },
    }
  },
}
