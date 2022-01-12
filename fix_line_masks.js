import fs from 'fs'
import path from 'path'
import cliProgress from 'cli-progress'
import chalk from 'chalk'
import yaml from 'js-yaml'
import parseArgs from 'minimist'

import AXL from './utils/cucm-axl.js'

const args = parseArgs(process.argv.slice(2))

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8')).CHECK_LINE_MASK

const e164MaskHidden = `+${config.COUNTRY_CODE}${config.PREFIX}${config.DN_MAIN}`
const e164MaskStandard = `+${config.COUNTRY_CODE}${config.PREFIX}${'X'.repeat(config.DN_LENGTH)}`

const axl = new AXL()
const progressBar = new cliProgress.SingleBar({ format: '{percentage}% [{bar}] {value}/{total} | Duration: {duration_formatted} | ETA: {eta_formatted}' }, cliProgress.Presets.rect)

// Define counters
const count = {
  correct: 0,
  correctHidden: 0,
  fixedPrefix: 0,
  fixedPrefixHidden: 0,
  fixedWrong: 0,
  fixedNoMask: 0,
  fixedCallInfoDisplay: 0,
  noLine: 0
}
let counter = 0

const phoneTypes = config.INCLUDED_DEVICES
const allowedPhoneTypes = Object.keys(phoneTypes).map((key) => phoneTypes[key]).flat()

// Get a list of all devices in Call Manager
const phones = await axl.list('Phone', { name: '%' }, ['name'])
  .catch((err) => {
    console.error('Connection Error:', err.message)
    process.exit(1)
  })

// Sort phones by name alphabeticaly
phones.sort((a, b) => a.name > b.name ? 1 : -1)

// Start progress bar with defined length
progressBar.start(phones.length, 0)

for (const p of phones) {
  let fixedLineCounter = 0
  counter++

  // Check if prefix is valid
  if (!allowedPhoneTypes.includes(p.name.slice(0, 3))) {
    progressBar.increment()
    continue
  }

  const phone = await axl.get('Phone', { uuid: p.$.uuid })

  // Skip if phone has no lines
  if (!phone.lines) {
    count.noLine++

    // Remove progress bar from line before we print updated e164Mask
    process.stdout.clearLine()
    process.stdout.cursorTo(0)

    console.log(`\n${counter}/${phones.length} ${chalk.yellow(p.name)} has no lines`)

    progressBar.increment()
    continue
  }

  const lines = Array.isArray(phone.lines.line) ? phone.lines.line : [phone.lines.line]

  for (const line of lines) {
    let e164Mask = typeof line.e164Mask === 'string' ? line.e164Mask : null
    const callInfoDisplay = line.callInfoDisplay
    const pattern = line.dirn.pattern

    if (!e164Mask) {
      // Line on phone contains no e164Mask

      // Set e164Mask
      line.e164Mask = e164MaskStandard

      if (pattern.length > 4) {
        // If pattern is longer than 4 digits we assume it is a special case and set the e164Mask to the main number
        line.e164Mask = e164MaskHidden
      }

      count.fixedNoMask++
      fixedLineCounter++

      e164Mask = `${chalk.red('None')} -> ${chalk.green(line.e164Mask)}`
    } else if (e164Mask.slice(0, -config.DN_LENGTH) === `${config.PREFIX}`) {
      // Line on phone contains e164Mask that begins with PREFIX

      // Set e164Mask
      line.e164Mask = `+${config.COUNTRY_CODE}${config.PREFIX}${line.e164Mask.slice(-config.DN_LENGTH)}`

      if (e164Mask.slice(-config.DN_LENGTH) === 'X'.repeat(config.DN_LENGTH)) {
        count.fixedPrefix++

        e164Mask = `${e164Mask} -> ${chalk.green(line.e164Mask)}`
      } else {
        count.fixedPrefixHidden++

        e164Mask = `${chalk.cyan(e164Mask)} -> ${chalk.green(line.e164Mask)}`
      }

      fixedLineCounter++
    } else if (e164Mask.slice(0, -config.DN_LENGTH) === `+${config.COUNTRY_CODE}${config.PREFIX}`) {
      // Line on phone contains e164Mask that begins with + COUNTRY_CODE AND PREFIX

      if (e164Mask.slice(-config.DN_LENGTH) === 'X'.repeat(config.DN_LENGTH)) {
        count.correct++
      } else {
        count.correctHidden++

        e164Mask = `${chalk.cyan(e164Mask)}`
      }
    } else {
      // Set e164Mask
      line.e164Mask = e164MaskStandard

      count.fixedWrong++
      fixedLineCounter++

      e164Mask = `${chalk.yellow(e164Mask)} -> ${chalk.green(line.e164Mask)}`
    }

    if (callInfoDisplay.callerName === 'false' || callInfoDisplay.dialedNumber === 'false') {
      callInfoDisplay.callerName = 'true'
      callInfoDisplay.dialedNumber = 'true'

      count.fixedCallInfoDisplay++
      fixedLineCounter++
    }

    // Print if we are changing e164Mask
    if (e164Mask.includes('->')) {
      // Remove progress bar from line before we print updated e164Mask
      process.stdout.clearLine()
      process.stdout.cursorTo(0)

      console.log(`${counter}/${phones.length} ${p.name} ${pattern} ${e164Mask}`)
    }
  }

  // Update devices with new e164Mask
  if (fixedLineCounter > 0) {
    await axl.updatePhone(p.$.uuid.slice(1, -1), { lines: phone.lines })
  }

  progressBar.increment()
}

// Redraw the counter in case it was overwritten
progressBar.update(counter)
// Stop the counter
progressBar.stop()

// Display statistics
console.log(`\nFound ${phones.length} phones`)
console.log(JSON.stringify(count))
