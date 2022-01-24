import { stdout } from 'process'
import fs from 'fs/promises'
import path from 'path'
import stripAnsi from 'strip-ansi'
import yaml from 'js-yaml'
import parseArgs from 'minimist'

const args = parseArgs(process.argv.slice(2))

// Load config file
const config = yaml.load(await fs.readFile(path.resolve(args.config || './config/config.yml'), 'utf8'))

class Logger {
  constructor (file) {
    this.file = `${file}.${new Date().toISOString().slice(0, 10)}.log` || `logger.${new Date().toISOString().slice(0, 10)}.log`
  }

  log = (args, level = 'INFO:', silent = false) => {
    if (!silent) {
      stdout.clearLine()
      stdout.cursorTo(0)
    }

    let content = ''

    for (const arg of args) {
      const output = typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg

      if (!silent) stdout.write(`${output}\n`)

      content += `${output}\n`
    }

    fs.writeFile(
      `./logs/${this.file}`,
      `${new Date().toISOString()} ${level} ${stripAnsi(content)}`,
      { flag: 'a+' },
      err => { throw err })
  }

  trace = (...args) => { if (['TRACE'].includes(config.LOGLEVEL.toUpperCase())) this.log(args, 'TRACE:') }

  debug = (...args) => { if (['TRACE', 'DEBUG'].includes(config.LOGLEVEL.toUpperCase())) this.log(args, 'DEBUG:') }

  info = (...args) => { if (['TRACE', 'DEBUG', 'INFO'].includes(config.LOGLEVEL.toUpperCase())) this.log(args, 'INFO:') }

  warn = (...args) => { if (['TRACE', 'DEBUG', 'INFO', 'WARN'].includes(config.LOGLEVEL.toUpperCase())) this.log(args, 'WARN:') }

  error = (...args) => { if (['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'].includes(config.LOGLEVEL.toUpperCase())) this.log(args, 'ERROR:') }

  fatal = (...args) => { if (['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(config.LOGLEVEL.toUpperCase())) this.log(args, 'FATAL:') }

  backup = (...args) => { this.log(args, 'BACKUP:', true) }
}

export default Logger
