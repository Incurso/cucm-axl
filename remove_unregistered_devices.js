import fs from 'fs'
import path from 'path'
// import cliProgress from 'cli-progress'
// import chalk from 'chalk'
import yaml from 'js-yaml'
import parseArgs from 'minimist'
import prompts from 'prompts'
import { fileURLToPath } from 'url'

import AXL from './utils/cucm-axl.js'
import Logger from './utils/logger.js'

const args = parseArgs(process.argv.slice(2))

// Display help and exit if
if (args.help) {
  console.log(`Usage: node ${path.basename(process.argv.slice(1, 2).toString())} [OPTION]\n`)
  console.log(`${'--config <inputfilename>'.padEnd(35)} Load YAML config file.`)
  console.log(`${'--cutoff-mark'.padEnd(35)} Cut-off mark in days.`)
  console.log(`${'--help'.padEnd(35)} Displays this help and exit.`)
  console.log(`${'--included-phone-prefixes <ATA,SEP>'.padEnd(35)} Include devices with name prefix.`)
  console.log(`${'--remove-all'.padEnd(35)} Removes all devices found to be expired.`)
  // console.log(`${'--verbose'.padEnd(35)} Enables verbose output`)
  console.log('')
  process.exit(0)
}

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8')).CLEANUP_UNREGISTERED_DEVICES

const logger = new Logger(path.basename(fileURLToPath(import.meta.url)).replace(/\.js$/, ''))
logger.info('Starting...')

const axl = new AXL()

// Check if we want to delete all devices from args
let removeAllDevices = args['remove-all'] // ? true : false
// const verbose = args.verbose // ? true : false

// Assign values from config
const phonePrefixes = args['included-phone-prefixes'] ? args['included-phone-prefixes'].split(',') : config.INCLUDED_DEVICES || []
const allowedPhonePrefixes = Object.keys(phonePrefixes).map((key) => phonePrefixes[key]).flat()
const excludedDescriptions = config.EXCLUDED.DESCRIPTIONS || []
const excludedDevices = config.EXCLUDED.DEVICES || []
const excludedDN = config.EXCLUDED.DN || []
const excludedModels = config.EXCLUDED.MODELS || []
const cutoffMark = args['cutoff-mark'] || config.CUTOFF_MARK

// Query that finds every device in the call manager and returns when it was last used
// Had to use between as less than was always throwing an error
const query = `
  SELECT
    d.pkid,
    d.name,
    tm.name AS model,
    np.dnorpattern,
    d.description,
    rd.lastactive,
    rd.lastseen,
    trs.name AS status
  FROM registrationdynamic AS rd
    INNER JOIN device AS d ON d.pkid = rd.fkdevice
    INNER JOIN typemodel AS tm ON tm.enum = d.tkmodel
    INNER JOIN devicenumplanmap as dnp ON dnp.fkdevice = d.pkid
    INNER JOIN numplan np ON np.pkid = dnp.fknumplan
    LEFT JOIN typerisstatus AS trs ON trs.enum = rd.tkrisstatus
  WHERE rd.lastseen != 0
    AND rd.lastseen BETWEEN 0 AND ${Math.round((Date.now() / 1000) - (cutoffMark * 24 * 60 * 60))}
  ORDER BY rd.lastseen
`

logger.debug(query)

// Execute Query
const devices = await axl.executeSQLQuery(query)
  .catch(err => {
    logger.error('Connection Error:', err.message)
    process.exit(1)
  })

logger.debug(`Found ${devices.length} devices that need to be filtered.`)
logger.debug(Object.keys(devices[0]), devices[0].lastseen)

// Remove everything except what we want
const unregisteredDevices = devices
  // Exclude devices that have never registered
  .filter((device) => device.lastseen !== '0')
  // Only include devices with allowed PREFIX
  .filter((device) => allowedPhonePrefixes.includes(device.name.slice(0, 3)))
  // Exclude devices by DESCRIPTION
  .filter((device) => !excludedDescriptions.filter(ed => device.description.includes(ed)).length)
  // Exclude devices by MODEL
  .filter((device) => !excludedModels.includes(device.model))
  // Exclude devices by DN
  .filter((device) => !excludedDN.includes(device.dnorpattern))
  // Exclude devices by NAME
  .filter((device) => !excludedDevices.includes(device.name))
  // Exclude devices by LAST_SEEN_LIMIT
  .filter((device) => ((Date.now() / 1000) - device.lastseen) > cutoffMark * 24 * 60 * 60)

// Print out a list of devices that were found
logger.info(`Devices unregistered for more than ${cutoffMark} days`)
logger.info('-'.repeat(110))
logger.info(`${'name'.padEnd(15)} | ${'model'.padEnd(25)} | ${'pattern'.padEnd(8)} | ${'description'.padEnd(40)} | ${'last'.padEnd(10)}`)
logger.info('-'.repeat(110))
for (const device of unregisteredDevices) {
  logger.info(`${device.name.padEnd(15)} | ${device.model.slice(0, 25).padEnd(25)} | ${device.dnorpattern.padEnd(8)} | ${typeof device.description === 'string' ? device.description.slice(0, 40).padEnd(40) : ''.padEnd(40)} | ${(new Date(device.lastseen * 1000)).toISOString([], {}).slice(0, 10).replace(/-/g, '.').padEnd(10)}`)
}
logger.info('-'.repeat(110))
logger.info(`Total: ${unregisteredDevices.length}`)

// Check if we found devices prompt for deletion of we found any
if (unregisteredDevices.length === 0) {
  logger.info(`Found no device that has been unregistered for more than ${cutoffMark} days.`)
  process.exit(0)
}

const removeDevices = removeAllDevices || (await prompts({
  type: 'confirm',
  name: 'removeDevices',
  message: 'Remove devices?',
  initial: false
})).removeDevices

if (removeAllDevices || removeDevices) {
  for (const device of unregisteredDevices) {
    let removeDevice = false

    if (!removeAllDevices) {
      const { answer } = await prompts({
        type: 'select',
        name: 'answer',
        message: `Remove device ${device.name}?`,
        choices: [
          { title: 'yes', value: 'yes' },
          { title: 'no', value: 'no' },
          { title: 'all', value: 'all' }
        ],
        initial: 1
      })

      removeAllDevices = answer === 'all' // ? true : false
      removeDevice = answer === 'yes'
    }

    if (removeAllDevices || removeDevice) {
      logger.backup(await axl.get('Phone', { name: device.name }))

      await axl.removePhone(device.pkid)

      logger.info(`Removed ${device.name}`)
    }
  }
}
