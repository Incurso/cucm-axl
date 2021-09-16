import fs from 'fs'
import path from 'path'
import cliProgress from 'cli-progress'
import chalk from 'chalk'
import yaml from 'js-yaml'
import parseArgs from 'minimist'
import Prompt from 'prompt-sync'

import AXL from './utils/cucm-axl.js'

const args = parseArgs(process.argv.slice(2))

// Display help and exit if 
if (args.help) {
  console.log(`Usage: node ${path.basename(process.argv.slice(1,2).toString())} [OPTION]\n`)
  console.log(`${'--config <inputfilename>'.padEnd(32)} Load YAML config file.`)
  console.log(`${'--cutoffmark'.padEnd(32)} Cut-off mark in days.`)
  console.log(`${'--deleteall'.padEnd(32)} Deletes all devices found to be expired.`)
  console.log(`${'--includeddevices <ATA,SEP>'.padEnd(32)} Include devices with name prefix.`)
  console.log(`${'--help'.padEnd(32)} Displays this help and exit.`)
  console.log('')
  process.exit(0)
}

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8')).CLEANUP_UNREGISTERED_DEVICES

const axl = new AXL()
const prompt = new Prompt({ sigint: true })

// Query that finds every device in the call manager and returns when it was last used
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
  ORDER BY rd.lastseen
`

// Execute Query
const devices = await axl.executeSQLQuery(query)
  .catch(err => { throw err })

console.log('Gotten devices.')

// Assign values from config
const phoneTypes = args.includeddevices ? args.includeddevices.split(',') : config.INCLUDED_DEVICES || []
const allowedPhoneTypes = Object.keys(phoneTypes).map((key) => phoneTypes[key]).flat()
const excludedDescriptions = config.EXCLUDED.DESCRIPTIONS || []
const excludedDevices = config.EXCLUDED.DEVICES || []
const excludedDN = config.EXCLUDED.DN || []
const excludedModels = config.EXCLUDED.MODELS || []
const cutoffMark = args.cutoffmark || config.CUTOFF_MARK

// Remove everything except what we want
const unregistered_devices = devices
  // Exclude devices that have never registered
  .filter((device) => device.lastseen !== '0')
  // Only include devices with allowed PREFIX
  .filter((device) => allowedPhoneTypes.includes(device.name.slice(0,3)))
  // Exclude devices by DESCRIPTION
  .filter((device) => !excludedDescriptions.includes(device.description))
  // Exclude devices by MODEL
  .filter((device) => !excludedModels.includes(device.model))
  // Exclude devices by DN
  .filter((device) => !excludedDN.includes(device.dnorpattern))
  // Exclude devices by NAME
  .filter((device) => !excludedDevices.includes(device.name))
  // Exclude devices by LAST_SEEN_LIMIT
  .filter((device) => ((Date.now()/1000) - device.lastseen) > cutoffMark * 24 * 60 * 60)

// Print out a list of devices that were found
console.log(`Devices unregistered for more than ${cutoffMark} days`)
console.log('-'.repeat(110))
console.log(`${'name'.padEnd(15)} | ${'model'.padEnd(25)} | ${'pattern'.padEnd(8)} | ${'description'.padEnd(40)} | ${'last'.padEnd(10)}`)
console.log('-'.repeat(110))
for (const device of unregistered_devices) {
  console.log(`${device.name.padEnd(15)} | ${device.model.slice(0,25).padEnd(25)} | ${device.dnorpattern.padEnd(8)} | ${typeof device.description === 'string' ? device.description.slice(0,40).padEnd(40) : ''.padEnd(40)} | ${(new Date(device.lastseen * 1000)).toISOString([], {}).slice(0,10).replace(/-/g, '.').padEnd(10)}`)
}
console.log('-'.repeat(110))
console.log(`Total: ${unregistered_devices.length}`)

// Check if we found devices prompt for deletion of we found any
if (unregistered_devices.length === 0) {
  console.log(`Found no device that has been unregistered for more than ${cutoffMark} days.`)
  process.exit(0)
}

// Check if we want to delete all devices from args
let deleteAllDevices = args.deleteall ? true : false

let deleteDevices = ''

while (!deleteAllDevices && !deleteDevices.match(/^[yn]$/)) {
  deleteDevices = prompt('Delete devices [y/N]: ', { value: 'N' }).toLowerCase()

  if (!deleteDevices.match(/^[yn]$/)) {
    console.log(`Invalid input: ${deleteDevices}`)
  }
}

if (deleteAllDevices || deleteDevices.match(/^[y]$/)) {
  for (const device of unregistered_devices) {
    let deleteDevice = ''

    while (!deleteAllDevices && !deleteDevice.match(/^[yna]$/)) {
      deleteDevice = await prompt(`Delete ${device.name} [y/N/a]: `, { value: 'N' }).toLowerCase()

      if (!deleteDevice.match(/^[yna]$/)) {
        console.log(`Invalid input: ${deleteDevice}`)
      }
    }

    // Check if user wants to delete all
    deleteAllDevices = deleteDevice.match(/^[a]$/)
    
    if (deleteAllDevices || deleteDevice.match(/^[y]$/)) {
      await axl.removePhone(device.pkid)

      console.log(`Deleted ${device.name}`)
    }
  }
}