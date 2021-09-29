import fs from 'fs'
import path from 'path'
import cliProgress from 'cli-progress'
import chalk from 'chalk'
import yaml from 'js-yaml'
import parseArgs from 'minimist'

import AXL from './utils/cucm-axl.js'

const axl = new AXL()
const progressBar = new cliProgress.SingleBar({format: '{percentage}% [{bar}] {value}/{total} | Duration: {duration_formatted} | ETA: {eta_formatted}'}, cliProgress.Presets.rect)

const args = parseArgs(process.argv.slice(2))

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8')).FIX_USER_LINE_ASSOCIATION

// Assign values from config
const phonePrefixes = args['included-phone-prefixes'] ? args.includeddevices.split(',') : config.INCLUDED_DEVICES || []
const allowedPhonePrefixes = Object.keys(phonePrefixes).map((key) => phonePrefixes[key]).flat()
console.log(phonePrefixes.SOFT)
// Define counters
const count = {
  total: 0,
  inactive: 0,
  strange: 0,
  nodevice: 0,
  local: 0,
  associated: 0,
  fixed: 0,
  notincucm: 0,
  ignored: 0,
  ok: 0
}
let counter = 0

const ignoredPatterns = []
const includedPhonePrefix = ['CSF']

const users = await axl.list('User', { userid: 'einarsi%' }, ['userid'])
// Start progress bar with defined length
progressBar.start(users.length, 0)

for (const u of users) {
  counter++

  const user = await axl.get('User', { userid: u.userid })
  const userDevices = user.associatedDevices

  console.log(user)
  console.log('\nuserDevices', typeof userDevices, userDevices)
  //process.exit(0)

  if (typeof user.ldapDirectoryName !== 'string') {
    // Local user

    count['local']++
  } else if (user.status === 2) {
    // Inactive LDAP Synchronized User

    count['inactive']++
  } else if (Number.isNaN(user.telephoneNumber)) {
    // LDAP User with telephoneNumber that is strange
    count['strange']++
  } else if (ignoredPatterns.includes(user.telephoneNumber)) {
    // Ignored directory numbers
    count['ignored']++
  } else {
    // TODO: Check user line association and device control
    //console.log('\n', typeof user.telephoneNumber, user.telephoneNumber)
    const routePlans = await axl.list('RoutePlan', { dnOrPattern: user.telephoneNumber }, ['dnOrPattern', 'partition', 'type', 'routeDetail'])
    const devices = routePlans
      .filter((d) => d.type === 'Device')
      .filter((d) => typeof d.routeDetail === 'string')
      .filter((d) => {
        return (
          phonePrefixes.SOFT.includes(d.routeDetail.slice(0,3))
          && ((d.routeDetail.slice(3).toLowerCase() === user.userid)
          || d.routeDetail[0] === '$')
        )
        || phonePrefixes.PHYSICAL.includes(d.routeDetail.slice(0,3))
        || phonePrefixes.VIRTUAL.includes(d.routeDetail.slice(0,3))
      })
      .map((d) => d.routeDetail)

    

    /*
    for (const routePlan of routePlans) {
      console.log(routePlan.type, routePlan.type !== 'Device')
      if (routePlan.type !== 'Device') { console.log('TEST'); continue }
      devices.push(routePlan.routeDetail)
      if (routePlan.routeDetail) continue
      if (!includedPhonePrefix.includes(routePlan.routeDetail)) continue
      
    }
    */
    
    //console.log('\nrouteDetail:', devices)
  }

  // Remove progress bar from line before we print
  process.stdout.clearLine()
  process.stdout.cursorTo(0)
  
  console.log(`${counter}/${users.length} ${user.userid} ${user.telephoneNumber}`)
  
  progressBar.increment()
}

progressBar.stop()

console.log(`\n\nFound ${users.length} users`)
console.log(JSON.stringify(count))