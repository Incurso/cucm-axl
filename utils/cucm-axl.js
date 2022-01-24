// https://gitlab.com/ccondry/cucm-axl/blob/master/index.js

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import axios from 'axios'
import https from 'https'
import xml2js from 'xml2js'
import parseArgs from 'minimist'
import { fileURLToPath } from 'url'

import { decrypt } from './crypto.js'
import Logger from './logger.js'

const logger = new Logger(path.basename(fileURLToPath(import.meta.url)).replace(/\.js$/, ''))

const args = parseArgs(process.argv.slice(2))

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8')).CUCM

// Set connection defaults for axios
axios.defaults.baseURL = `${config.PROTOCOL}://${config.HOST}`
axios.defaults.headers = {
  SoapAction: `CUCM:DB ver=${config.VERSION}`,
  Authorization: `Basic ${Buffer.from(`${config.USER}:${decrypt(config.PASS)}`).toString('base64')}`,
  'Content-Type': 'text/xml; charset=utf-8'
}
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true })

// axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false }) // required to accept self-signed certificate

export default class AXL {
  async execute (method, type, content) {
    const methodType = method
    const returnType = type.charAt(0).toLowerCase() + type.slice(1)

    const soapBody = `
      <soapenv:Envelope
      xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
      xmlns:xsd="http://www.w3.org/2001/XMLSchema"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <soapenv:Body>
          <axl:${methodType} xmlns:axl="http://www.cisco.com/AXL/API/${config.VERSION}">
            ${content}
          </axl:${methodType}>
        </soapenv:Body>
      </soapenv:Envelope>
    `

    const res = await axios.post('/axl/', soapBody)
      .catch((err) => err.response) // Return response error and work with it later

    logger.debug(`Method: ${res.request.method}, URL: ${res.request.protocol}//${res.request.host}${res.request.path}, Payload: ${res.data}`)
    logger.debug(`Response: ${res.status}, ${res.data}`)

    const soapenvBody = await xml2js.parseStringPromise(res.data, { explicitArray: false, emptyTag: null })
      .then(data => data['soapenv:Envelope']['soapenv:Body'])

    const soapenvFault = soapenvBody['soapenv:Fault'] // Grab soap error if there is one
    const nsResponse = soapenvBody[`ns:${methodType}Response`]

    if (soapenvFault) {
      if (soapenvFault.faultstring !== 'No more than 5 EndUsers can be subscribed to receive status for a line appearance.') {
        logger.error(soapenvFault)
        logger.error('Content:', content)

        throw new Error(soapenvFault.faultstring)
      }
    } else {
      const response = nsResponse.return ? nsResponse.return[returnType] : []

      // If method is list, always return an array
      return method === `list${type}` && response.constructor === Object ? [response] : response
    }
  }

  apply (type, uuid) {
    return this.execute(`apply${type}`, type, `<uuid>${uuid}</uuid>`)
  }

  get (type, searchCriteria) {
    const content = `
      ${Object.keys(searchCriteria).map((key) => `<${key}>${searchCriteria[key]}</${key}>`).join('')}
    `

    return this.execute(`get${type}`, type, content)
      .catch((err) => {
        throw new Error(
          `\nget${type} Error: ${err.message}` +
          `\nPayload:${JSON.stringify(searchCriteria, null, 2)}`
        )
      })
  }

  list (type, searchCriteria, returnedTags) {
    const content = `
      <searchCriteria>
        ${Object.keys(searchCriteria).map((key) => `<${key}>${searchCriteria[key]}</${key}>`).join('')}
      </searchCriteria>
      <returnedTags>
        ${Object.keys(returnedTags).map((key) => `<${returnedTags[key]} />`).join('')}
      </returnedTags>
    `

    return this.execute(`list${type}`, type, content)
      .catch((err) => {
        throw new Error(`\nlist${type} Error: ${err.message}`)
      })
  }

  updateUserDeviceAssociation (userid, devices) {
    const content = `
      <userid>${userid}</userid>
      <associatedDevices>
        ${devices.map(device => `<device>${device}</device>`).join('')}
      </associatedDevices>
    `

    return this.execute('updateUser', 'User', content)
  }

  updateUserLineAssociation (userid, lines) {
    const content = `
      <userid>${userid}</userid>
      <lineAppearanceAssociationForPresences>
        ${lines.map(line => `
          <lineAppearanceAssociationForPresence uuid="${line._attributes.uuid}">
            ${Object.keys(line).map((key) => {
              if (key !== '_attributes') { // Remove _attributes
                return `<${key}>${line[key]}</${key}>`
              }
              return null
            }).join('')}
          </lineAppearanceAssociationForPresence>
        `).join('')}
      </lineAppearanceAssociationForPresences>
    `

    return this.execute('updateUser', 'User', content)
  }

  async updateUser (userid, payload) {
    const builder = new xml2js.Builder({ headless: true })

    const content = `
      <userid>${userid}</userid>
      ${builder.buildObject(payload)}
    `.replace(/<root>|<root uuid="{.{36}}">|<\/root>/g, '')

    return await this.execute('updateUser', 'User', content)
      .catch((err) => {
        throw new Error(
          `\nupdateUser Error: ${err.message}` +
          `\nWhile trying to update User: ${userid}` +
          `\nPayload:${JSON.stringify(payload, null, 2)}`
        )
      })
  }

  async updateLineByUUID (uuid, payload) {
    const builder = new xml2js.Builder({ headless: true })

    if (payload.useEnterpriseAltNum === 'false') delete payload.enterpriseAltNum
    if (payload.useE164AltNum === 'false') delete payload.e164AltNum

    const content = `
      <uuid>${uuid}</uuid>
      ${builder.buildObject(payload)}
    `.replace(/<root>|<root uuid="{.{36}}">|<\/root>/g, '')

    return await this.execute('updateLine', 'Line', content)
      .catch((err) => {
        throw new Error(
          `\nupdateUser Error: ${err.message}` +
          `\nWhile trying to update Line: ${payload.pattern}` +
          `\nPayload:${JSON.stringify(payload, null, 2)}`
        )
      })
  }

  updateLine ({ pattern, callForwardAll }) {
    const content = `
      <pattern>${pattern}</pattern>
      <routePartitionName>Internal-Phones</routePartitionName>
      <callForwardAll>
        <destination>${callForwardAll.destination}</destination>
      </callForwardAll>
    `

    return this.execute('updateLine', 'Line', content)
  }

  updateLineFWAllByUUID (lineId, cssId) {
    const content = `
      <uuid>${lineId}</uuid>
      <callForwardAll>
        <callingSearchSpaceName uuid="${cssId}"></callingSearchSpaceName>
      </callForwardAll>
    `

    return this.execute('updateLine', 'Line', content)
  }

  updatePhone (uuid, payload) {
    const builder = new xml2js.Builder({ headless: true })

    const content = `
      <uuid>${uuid}</uuid>
      ${builder.buildObject(payload)}
    `

    return this.execute('updatePhone', 'Phone', content)
  }

  removePhone (uuid) {
    const content = `
      <uuid>${uuid}</uuid>
    `

    return this.execute('removePhone', 'Phone', content)
  }

  async executeSQLQuery (query) {
    const content = `
      <sql>${query}</sql>
    `

    return await this.execute('executeSQLQuery', 'row', content)
  }

  async getHuntLists () {
    const query = `
      SELECT n.dNOrPattern AS HuntPilot, d.name AS HuntList, d.description, rl.selectionorder, lg.name AS LineGroup 
      FROM device AS d 
        INNER JOIN routelist AS rl ON rl.fkDevice=d.pkid 
        INNER JOIN DeviceNumPlanMap AS dmap ON dmap.fkDevice=d.pkid 
        INNER JOIN NumPlan AS n ON n.pkid=dmap.fkNumPlan 
        INNER JOIN linegroup lg ON rl.fklinegroup = lg.pkid  
      ORDER BY n.dnorpattern
    `

    return await this.executeSQLQuery(query)
  }

  async getLineGroup (name) {
    const query = `
      SELECT lg.name AS LineGroup, n.dnorpattern, d.name AS DeviceName, d.description, dhd.hlog
      FROM linegroup AS lg
        INNER JOIN linegroupnumplanmap AS lgmap ON lgmap.fklinegroup=lg.pkid
        INNER JOIN numplan AS n ON lgmap.fknumplan = n.pkid
        INNER JOIN devicenumplanmap AS dmap ON dmap.fknumplan = n.pkid
        INNER JOIN device AS d ON dmap.fkdevice=d.pkid
        INNER JOIN devicehlogdynamic AS dhd ON dhd.fkdevice=d.pkid
      WHERE lg.name = '${name}'
      ORDER BY lg.name
    `

    return await this.executeSQLQuery(query)
  }

  async add (type, payload) {
    const builder = new xml2js.Builder({ headless: true, rootName: type.toLowerCase() })

    const content = builder.buildObject(payload)

    return await this.execute(`add${type}`, type, content)
      .then(() => {
        logger.info(`Added ${type}: ${JSON.stringify(payload, null, 2)}`)

        return true
      })
      .catch((err) => {
        throw new Error(
          `add${type}: ${err.message}\n` +
          `Payload: ${JSON.stringify(payload, null, 2)}`
        )
      })
  }
}
