import winston, { format } from 'winston'
import { LoggerConfig } from './types/index'

const levels = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
}

const colors = {
    error: 'red',
    warn: 'yellow',
    info: 'white',
    debug: 'green',
}

winston.addColors(colors)

const rmInfoProps = (info) => {
    let {message, timestamp, level, ...rest} = info;
    return rest
}

const getConsoleFormat = (cfg: LoggerConfig) => {
    const getFormatString = (info) => {
        let logString = `[${info.level.substring(0, 1).toUpperCase()}| ${info.timestamp} ${cfg.prefix}`.padEnd(30, ' ') + `] ${info.message}` 
        const metadata = rmInfoProps(info)

        if (Object.keys(metadata).length !== 0 && cfg.printMetadata)
            logString += `\n${JSON.stringify(metadata, null, 2)}\n${'_'.repeat(50)}`
    
        return logString
    }

    return winston.format.combine(
        winston.format.timestamp({ format: `HH:mm:ss` }),
        winston.format.printf(
            (info) => getFormatString(info)            
            ),
            winston.format.colorize({ all: true }),
        )
}

const getFileFormat = (cfg: LoggerConfig) => {
    const onlyInfoProps = (({ message, timestamp, level }) => ({ message, timestamp, level }))

    const getFormatObj = (info) => {
        let logObj = {
            ...onlyInfoProps(info as any),
            'prefix': cfg.prefix
        }
        const metadata = rmInfoProps(info)
        if (Object.keys(metadata).length !== 0)
            logObj['metadata'] = metadata

        return JSON.stringify(logObj)
    }

    return winston.format.combine(
        winston.format.timestamp({ format: `YYYY-MM-DD HH:mm:ss` }),
        winston.format.printf(
            (info) => getFormatObj(info)
        ),
        winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'label'] }),
        )
}

const getTransports = (cfg: LoggerConfig) => [
    new winston.transports.Console({
        level: cfg.level,
        format: getConsoleFormat(cfg)
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: getFileFormat(cfg)
    }),
    new winston.transports.File({
        filename: 'logs/all.log',
        level: 'debug',
        format: getFileFormat(cfg)
    })
]

export const getLogger = (cfg: LoggerConfig) => {
    return winston.createLogger({
        levels,
        transports: getTransports(cfg),
    })
}

export const globalLogger = getLogger({
    prefix: 'global logger',
    printMetadata: true,
    level: 'debug',
})