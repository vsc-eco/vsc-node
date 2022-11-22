import winston from 'winston'

const consoleFormat = winston.format.combine(
  winston.format.colorize({
    all: true,
  }),
  winston.format.label({
    label: '[LOGGER]',
  }),
  winston.format.timestamp({
    format: 'MM/DD/YYYY HH:m:s',
  }),
  winston.format.printf(
    (info) => `${info.label}  ${info.timestamp}  ${info.level} : ${info.message}`,
  ),
)

export const logger = winston.createLogger({
  level: 'verbose', //Or Info
  format: winston.format.json(),
  defaultMeta: { service: 'vsc-node' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({ format: consoleFormat }),
  ],
})
