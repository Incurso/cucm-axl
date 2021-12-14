import fs from 'fs'
import path from 'path'
import cliProgress from 'cli-progress'
import chalk from 'chalk'
import yaml from 'js-yaml'
import parseArgs from 'minimist'
import stripAnsi from 'strip-ansi'

import AXL from './utils/cucm-axl.js'
import { print } from './utils/print.js'

console.time('Execution time')

const axl = new AXL()
const progressBar = new cliProgress.SingleBar({ format: '{percentage}% [{bar}] {value}/{total} | Duration: {duration_formatted} | ETA: {eta_formatted}' }, cliProgress.Presets.rect)

const args = parseArgs(process.argv.slice(2))

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8')).FIX_USER_LINE_ASSOCIATION

// Assign values from config
const phonePrefixes = args['included-phone-prefixes'] ? args.includeddevices.split(',') : config.INCLUDED_DEVICES || []

// Define counters
const count = {
  inactive: 0,
  invalid: 0,
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
const messages = []

const users = await axl.list(
  'User',
  { userid: '%' },
  ['userid', 'department', 'status', 'telephoneNumber']
)
  .catch((err) => {
    console.error(err.message)
  })

// Get route plans for directory number
const routePlans = await axl.list(
  'RoutePlan',
  { dnOrPattern: '%', type: 'Device', partition: 'Internal-Phones' },
  ['dnOrPattern', 'partition', 'type', 'routeDetail']
)
  .catch((err) => {
    console.error(err.message)
  })

// Sort usersalphabeticaly by userid
users.sort((a, b) => a.userid > b.userid ? 1 : -1)

// Start progress bar with defined length
progressBar.start(users.length, 0)

for (const u of users) {
  counter++
  let counterKey = 'ok'
  let reasonCode = null
  let note = ''

  let user = await axl.get('User', { userid: u.userid })
    .catch((err) => {
      console.error(err.message)
    })

  const userDevices = user.associatedDevices
    ? Array.isArray(user.associatedDevices.device)
      ? user.associatedDevices.device
      : [user.associatedDevices.device]
    : []

  if (!user.ldapDirectoryName) {
    // Local user
    counterKey = 'local'
  } else if (u.status === '2') {
    // Inactive LDAP Synchronized User
    counterKey = 'inactive'
    reasonCode = chalk.cyan(counterKey.toUpperCase())
    note = 'inactive LDAP user'
  } else if (!u.telephoneNumber || !u.telephoneNumber.match(/^[0-9]{4}$|^10[0-9]{6}$/)) {
    // LDAP User with telephoneNumber that is invalid
    counterKey = 'invalid'
    reasonCode = chalk.magenta(counterKey.toUpperCase())
  } else if (ignoredPatterns.includes(u.telephoneNumber)) {
    // Ignored directory numbers
    counterKey = 'ignored_number'
    reasonCode = config.LOGLEVEL === 'debug' ? chalk.blue(counterKey.toUpperCase()) : null
    note = 'invalid directory number'
  } else if (config.IGNORED_DEPARTMENTS.includes(u.department)) {
    // Ignored departments
    counterKey = 'ignored_department'
    reasonCode = config.LOGLEVEL === 'debug' ? chalk.blue(counterKey.toUpperCase()) : null
  } else {
    // TODO: Check user line association and device control

    // Filter route plans for only devices and that has a device associated with it
    const devices = routePlans
      .filter((d) => d.dnOrPattern === u.telephoneNumber)
      .filter((d) => d.type === 'Device')
      .filter((d) => d.partition)
      .filter((d) => d.partition._ === 'Internal-Phones')
      .filter((d) => d.routeDetail)
      .filter((d) => {
        const deviceName = d.routeDetail._

        return (
          phonePrefixes.SOFT.includes(deviceName.slice(0, 3)) &&
          ((deviceName.slice(3).toLowerCase() === user.userid) ||
          user.userid[0] === '$')
        ) ||
        phonePrefixes.PHYSICAL.includes(deviceName.slice(0, 3)) ||
        phonePrefixes.VIRTUAL.includes(deviceName.slice(0, 3))
      })
      .map((d) => d.routeDetail._)

    devices.sort()
    userDevices.sort()

    const addingDevices = devices.filter((d) => !userDevices.includes(d))
    const removingDevices = userDevices.filter((d) => !devices.includes(d))

    // Changing device association
    if (!!addingDevices.length || !!removingDevices.length) {
      counterKey = !userDevices.length ? 'associated' : 'fixed'
      reasonCode = chalk.green(counterKey.toUpperCase())
      const addingMessage = addingDevices.length
        ? `adding association to ${chalk.green(addingDevices)}${!removingDevices.length ? '' : ', '}`
        : ''
      const removingMessage = removingDevices.length
        ? `removing association from ${chalk.green(removingDevices)}`
        : ''

      note = `${addingMessage}${removingMessage}`

      user.associatedDevices = { device: devices }

      await axl.updateUser(user.userid, {
        associatedDevices: user.associatedDevices
      })
        .catch((err) => {
          console.error(err.message)
        })

      user = await axl.get('User', { userid: u.userid })
        .catch((err) => {
          console.error(err.message)
        })
    }

    // TODO: Changing line appearance association for presence

    if (user.lineAppearanceAssociationForPresences) {
      let primaryExt = user.primaryExtension
      let reasonCode = null
      const userLAAP = Array.isArray(user.lineAppearanceAssociationForPresences.lineAppearanceAssociationForPresence)
        ? user.lineAppearanceAssociationForPresences.lineAppearanceAssociationForPresence
        : [user.lineAppearanceAssociationForPresences.lineAppearanceAssociationForPresence]

      for (const laap of userLAAP) {
        const userDeviceLAAPCounter = userLAAP
          .filter(l => l.laapDirectory === laap.laapDirectory && l.laapDeviceName === laap.laapDeviceName).length

        // Check if primaryExtension is valid
        if (primaryExt?.routePartitionName !== 'Internal-Phones' || primaryExt?.pattern !== user.telephoneNumber) {
          const validLAAP = userLAAP.filter((d) => d.laapDirectory === user.telephoneNumber && d.laapPartition === 'Internal-Phones').shift()
          primaryExt = validLAAP ? { pattern: validLAAP.laapDirectory, routePartitionName: validLAAP.laapPartition } : ''
          reasonCode = 'invalid primary extension'
          break
        }

        if (laap.laapAssociate === 't' && laap.laapDirectory !== user.telephoneNumber && userDeviceLAAPCounter === 2) {
          // Check if wrong line is associated to user
          reasonCode = 'wrong association'
          break
        } else if (laap.laapAssociate === 'f' && laap.laapDirectory === user.telephoneNumber) {
          // Check if device with correct line is not associated
          reasonCode = 'missing association'
          break
        } else if (laap.laapAssociate === 't' && laap.laapDirectory === user.telephoneNumber && laap.laapPartition !== 'Internal-Phones') {
          reasonCode = 'wrong association'
          break
        }
      }

      if (reasonCode) {
        if (config.LOGLEVEL === 'debug') {
          print(`${user.userid} Updating LAAP: ${reasonCode}`)
        }

        const newUserLAAP = [
          ...userLAAP
            .filter((d) => d.laapDirectory === u.telephoneNumber && d.laapPartition === 'Internal-Phones')
            .reduce((map, obj) => map.set(obj.laapDeviceName, obj), new Map()).values()
        ]
          .map((d) => {
            d.laapAssociate = 't'

            return d
          })

        // TODO: Update line association
        user.lineAppearanceAssociationForPresences = {
          lineAppearanceAssociationForPresence: newUserLAAP
        }

        await axl.updateUser(user.userid, {
          primaryExtension: primaryExt,
          lineAppearanceAssociationForPresences: user.lineAppearanceAssociationForPresences
        })
          .catch((err) => {
            console.error(err.message)
          })
      }
    }
  }

  if (reasonCode) {
    messages.push({
      user: u.userid,
      tel: u.telephoneNumber,
      reason: stripAnsi(reasonCode),
      note
    })

    print(`${counter}/${users.length} User: ${u.userid}, Tel: ${u.telephoneNumber}, Reason: ${reasonCode}, Note: ${note}`)
  }

  count[counterKey]++
  progressBar.increment()
}

// Redraw the counter in case it was overwritten
progressBar.update(counter)
// Stop the counter
progressBar.stop()

const report = {
  NO_NUMBER: {
    title: 'Number not in Call Manager:',
    items: messages.filter(m => m.reason === 'NO_NUMBER').map(m => `User: ${m.user}, Tel: ${m.tel}`)
  },
  NO_DEVICE: {
    title: 'Number not assigned to a valid device:',
    items: messages.filter(m => m.reason === 'NO_DEVICE').map(m => `User: ${m.user}, Tel: ${m.tel}`)
  },
  INVALID: {
    title: 'Invalid directory number',
    items: messages.filter(m => m.reason === 'INVALID').map(m => `User: ${m.user}, Tel: ${m.tel}`)
  },
  ASSOCIATED: {
    title: 'New device/line association',
    items: messages.filter(m => m.reason === 'ASSOCIATED').map(m => `User: ${m.user}, Tel: ${m.tel}`)
  },
  FIXED: {
    title: 'Fixed device/line association',
    items: messages.filter(m => m.reason === 'FIXED').map(m => `User: ${m.user}, Tel: ${m.tel}`)
  }
}

// Display statistics
const body = []

for (const item of Object.values(report)) {
  if (item.items.length) {
    body.push(`${' '.repeat(4)}${item.title}`)
    body.push(item.items.map(i => `${' '.repeat(8)}${i}`).join('\n'))
  }
}

console.log(`\n${body.join('\n')}`)

console.log(`\n    Found ${users.length} users

${String('type').padStart(22, ' ')} | count
    ${'-'.repeat(30)}
${Object.entries(count).map(([key, value]) => `${String(key).padStart(22, ' ')} | ${value}`).join('\n')}
    ${'-'.repeat(30)}
${String('total').padStart(22, ' ')} | ${Object.values(count).reduce((a, b) => a + b)}
`)

console.timeEnd('Execution time')
