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

// Define counters
const count = {
  inactive: 0,
  strange: 0,
  nodevice: 0,
  local: 0,
  associated: 0,
  fixed: 0,
  notincucm: 0,
  ignored_number: 0,
  ignored_department: 0,
  ok: 0
}
let counter = 0

const ignoredPatterns = []

const users = await axl.list('User', { userid: 'es-test%' }, ['userid'])
// Start progress bar with defined length
progressBar.start(users.length, 0)

for (const u of users) {
  counter++
  let counterKey = 'ok'
  let reasonCode = null
  let note = ''

  const user = await axl.get('User', { userid: u.userid })
  const userDevices = user.associatedDevices ? user.associatedDevices.device : []

  //console.log(user)
  //console.log('\nuserDevices', typeof userDevices, userDevices)
  //process.exit(0)

  if (!user.ldapDirectoryName) {
    // Local user

    //count['local']++
    counterKey = 'local'
  } else if (user.status === 2) {
    // Inactive LDAP Synchronized User

    //count['inactive']++
    counterKey = 'inactive'
    reasonCode = chalk.cyan(counterKey.toUpperCase)
  } else if (Number.isNaN(user.telephoneNumber)) {
    // LDAP User with telephoneNumber that is strange
    //count['strange']++
    counterKey = 'strange'
    reasonCode = chalk.magenta(counterKey.toUpperCase())
  } else if (ignoredPatterns.includes(user.telephoneNumber)) {
    // Ignored directory numbers
    //count['ignored']++
    counterKey = 'ignored_number'
  } else if (config.IGNORED_DEPARTMENTS.includes(user.department)) {
    // Ignored departments
    counterKey = 'ignored_department'
  } else {
    // TODO: Check user line association and device control

    //console.log('\n', typeof user.telephoneNumber, user.telephoneNumber)
    const routePlans = await axl.list('RoutePlan', { dnOrPattern: user.telephoneNumber }, ['dnOrPattern', 'partition', 'type', 'routeDetail'])
    //console.log(routePlans)
    const devices = routePlans
      .filter((d) => d.type === 'Device')
      .filter((d) => d.routeDetail)
      .filter((d) => {
        const deviceName = d.routeDetail._

        return (
          phonePrefixes.SOFT.includes(deviceName.slice(0,3))
          && ((deviceName.slice(3).toLowerCase() === user.userid)
          || deviceName[0] === '$')
        )
        || phonePrefixes.PHYSICAL.includes(deviceName.slice(0,3))
        || phonePrefixes.VIRTUAL.includes(deviceName.slice(0,3))
      })
      .map((d) => d.routeDetail._)

    devices.sort()
    userDevices.sort()

    const addingDevices = devices.filter((d) => !userDevices.includes(d))
    const removingDevices = userDevices.filter((d) => !devices.includes(d))

    //console.log(!!addingDevices.length, !!removingDevices.length)

    // Changing device association
    if (!!addingDevices.length || !!removingDevices.length) {
      // Remove progress bar from line before we print
      //process.stdout.clearLine()
      //process.stdout.cursorTo(0)
    
      //console.log('\nCompare devices to userDevices', devices, userDevices)
      //console.log('Adding', devices.filter((d) => !userDevices.includes(d)))
      //console.log('Removing', userDevices.filter((d) => !devices.includes(d)))
  
      counterKey = !userDevices.length ? 'associated' : 'fixed'
      reasonCode = chalk.green(counterKey.toUpperCase())
      const addingMessage = addingDevices.length
        ? `adding association to ${chalk.green(addingDevices)}${!removingDevices.length ? '' : ', '}`
        : ''
      const removingMessage = removingDevices.length
        ? `removing association from ${chalk.green(removingDevices)}`
        : ''

      note = `${addingMessage}${removingMessage}`
    }

    // TODO: Changing line appearance association for presence
    const userLAAP = user.lineAppearanceAssociationForPresences
    const primaryExt = user.primaryExtension

    if (userLAAP) {
      //for (const laap of new Set(userLAAP.lineAppearanceAssociationForPresence)) {
      for (const laap of userLAAP.lineAppearanceAssociationForPresence) {
        if (laap.laapDirectory === user.telephoneNumber) {
          console.log('LAAP OK:', laap)
          console.log(primaryExt)
        } else {
          console.log('LAAP not OK:', laap)
        }
      }
      const test = userLAAP.lineAppearanceAssociationForPresence
        .filter((d) => d.laapDirectory === user.telephoneNumber)
        .map((d) => {
          d.laapAssociate = 't'

          return d
        })

      //console.log(test)
    }


    /*
    // Remove progress bar from line before we print updated e164Mask
    process.stdout.clearLine()
    process.stdout.cursorTo(0)

    console.log(`User: ${user.userid}, Tel: ${user.telephoneNumber}, Reason: ${counterKey.toUpperCase()}, Note: ${note}`)

    progressBar.increment()
    */
    /*
    console.log(chalk.green(JSON.stringify({
      user: user.userid,
      tel: user.telephoneNumber,
      reason: counterKey.toUpperCase(),
      note: `${addingMessage}${removingMessage}`
    })))
    */
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

  //console.log('\ncounterKey:', counterKey)

  if (reasonCode) {
    // Remove progress bar from line before we print
    process.stdout.clearLine()
    process.stdout.cursorTo(0)
    
    console.log(`${counter}/${users.length} User: ${user.userid}, Tel: ${user.telephoneNumber}, Reason: ${reasonCode}, Note: ${note}`)
    //console.log(user.userid, user.telephoneNumber, counterKey, note)
    //console.log(`\n${counter}/${users.length} ${user.userid} ${user.telephoneNumber}`)
  }
  
  count[counterKey]++
  progressBar.increment()
}

// Redraw the counter in case it was overwritten
progressBar.update(counter)
// Stop the counter
progressBar.stop()

// Display statistics
console.log(`\n\nFound ${users.length} users`)
console.log(JSON.stringify(count))