import winston from 'winston'

const level = () => {
    return 'debug'
    // const env = process.env.NODE_ENV || 'development'
    // const isDevelopment = env === 'development'
    // return isDevelopment ? 'debug' : 'warn'
}

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

const getFormat = (prefix: string) => {
    return winston.format.combine(
        winston.format.timestamp({ format: `YYYY-MM-DD HH:mm:ss` }),
        winston.format.colorize({ all: true }),
        winston.format.printf(
            (info) => `${info.timestamp} ${prefix} ${info.level}: ${info.message}`,
        ),
        )
}

const transports = [
    new winston.transports.Console(),
    // new winston.transports.File({
    //   filename: 'logs/error.log',
    //   level: 'error',
    // }),
    // new winston.transports.File({ filename: 'logs/all.log' }),
]

const getLogger = (prefix: string) => {
    return winston.createLogger({
        level: level(),
        levels,
        format: getFormat(prefix),
        transports,
    })
}

export default getLogger