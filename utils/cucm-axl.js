// https://gitlab.com/ccondry/cucm-axl/blob/master/index.js

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import axios from 'axios'
import https from 'https'
import xmljs from 'xml-js'
import parseArgs from 'minimist'

const args = parseArgs(process.argv.slice(2))

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8'))

// Set connection defaults for axios
axios.defaults.baseURL = `${config.CUCM.PROTOCOL}://${config.CUCM.HOST}`
axios.defaults.headers = {
  SoapAction: `CUCM:DB ver=${config.CUCM.VERSION}`,
  Authorization: `Basic ${Buffer.from(`${config.CUCM.USER}:${config.CUCM.PASS}`).toString('base64')}`,
  'Content-Type': 'text/xml; charset=utf-8'
}
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false }) // required to accept self-signed certificate

export default class AXL {
  async execute (method, returnType, content) {
    const methodType = `${method}`

    const soapBody = `
      <soapenv:Envelope
      xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
      xmlns:xsd="http://www.w3.org/2001/XMLSchema"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <soapenv:Body>
          <axl:${methodType} xmlns:axl="http://www.cisco.com/AXL/API/${config.CUCM.VERSION}">
            ${content}
          </axl:${methodType}>
        </soapenv:Body>
      </soapenv:Envelope>
    `

    console.log(`Executing: ${methodType}`)
    const res = await axios.post('/axl/', soapBody)
      .catch((err) => { return err.response })

    console.log(`Executed: ${methodType}`)
    console.log(res)

    const xmljsOptions = {
      compact: true,
      trim: true,
      // Remove _text from each Object and place it's value in it's parent
      textFn: (value, parentElement) => {
        try {
          const keyNo = Object.keys(parentElement._parent).length
          const keyName = Object.keys(parentElement._parent)[keyNo - 1]
          parentElement._parent[keyName] = value
        } catch (e) {}
      }
    }

    const soapenvBody = xmljs.xml2js(res.data, xmljsOptions)['soapenv:Envelope']['soapenv:Body']
    const soapenvFault = soapenvBody['soapenv:Fault'] // Grab soap error if there is one
    const nsResponse = soapenvBody[`ns:${methodType}Response`]

    if (soapenvFault) {
      console.log('Error:', soapenvFault.faultstring)
      throw Object.assign(new Error(soapenvFault.faultstring), { status: res.status })
    } else {
      const response = nsResponse.return[returnType.toLowerCase()] || []

      // If method is list, always return an array
      return method === 'list' && response.constructor === Object ? [response] : response
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

  updateLine ({ pattern, callForwardAll }) {
    const content = `
      <pattern>${pattern}</pattern>
      <routePartitionName>Internal-Phones</routePartitionName>
      <callForwardAll>
        <destination>${callForwardAll.destination}</destination>
      </callForwardAll>
    `

    console.log(content)

    return this.execute('updateLine', 'Line', content)
  }

  updateLineFWAllByUUID (lineId, cssId) {
    const content = `
      <uuid>${lineId}</uuid>
      <callForwardAll>
        <callingSearchSpaceName uuid="${cssId}"></callingSearchSpaceName>
      </callForwardAll>
    `

    console.log(content)

    return this.execute('updateLine', 'Line', content)
  }

  updatePhone (uuid, payload) {
    const content = `
      <uuid>${uuid}</uuid>
      ${xmljs.json2xml(payload, { compact: true, ignoreComment: true, spaces: 4 })}
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
}
