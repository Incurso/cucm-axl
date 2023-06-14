// https://developer.cisco.com/site/sxml/documents/operations-by-release/

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import axios from 'axios'
import https from 'https'
import xml2js from 'xml2js'
import parseArgs from 'minimist'
import logger from './logger.js'

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
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true })

export default class RisPort {
  async execute (method, type, content) {
    const methodType = method
    const returnType = type.charAt(0).toLowerCase() + type.slice(1)

    const soapBody = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap="http://schemas.cisco.com/ast/soap">
      <soapenv:Header/>
      <soapenv:Body>
          <soap:${methodType}>
            ${content}
          </soap:${methodType}>
        </soapenv:Body>
      </soapenv:Envelope>
    `

    const res = await axios.post('/realtimeservice2/services/RISService70/', soapBody)
      .catch((err) => {
        logger.log(err)
        throw new Error(err.message)
      })

    const soapenvBody = await xml2js.parseStringPromise(res.data, { explicitArray: false, emptyTag: '' })
      .then(data => data['soapenv:Envelope']['soapenv:Body'])

    const soapenvFault = soapenvBody['soapenv:Fault'] // Grab soap error if there is one
    const nsResponse = soapenvBody[`ns1:${returnType}Response`]

    if (soapenvFault) {
      if (soapenvFault.faultstring !== 'No more than 5 EndUsers can be subscribed to receive status for a line appearance.') {
        logger.log('Error:', soapenvFault.faultstring)
        logger.log('Content:', content)
        throw Object.assign(new Error(soapenvFault.faultstring), { status: res.status })
      }
    } else {
      const response = nsResponse[`ns1:${returnType}Return`][`ns1:${type}Result`]['ns1:CmNodes']['ns1:item']

      // If method is list, always return an array
      return Array.isArray(response) ? response : response ? [response] : []
    }
  }

  async selectCmDevice (devices) {
    const builder = new xml2js.Builder({ headless: true })

    const payload = {
      'soap:StateInfo': '',
      'soap:CmSelectionCriteria': {
        'soap:MaxReturnedDevices': '1000',
        'soap:DeviceClass': 'Phone',
        'soap:Model': '255',
        'soap:Status': 'Any',
        'soap:NodeName': '',
        'soap:SelectBy': 'Name',
        'soap:SelectItems': {
          'soap:item': devices.map(item => { return { 'soap:Item': item.name } })
        },
        'soap:Protocol': 'Any',
        'soap:DownloadStatus': 'Any'
      }
    }

    const content = `
      ${builder.buildObject(payload)}
    `.replace(/<root>|<root uuid="{.{36}}">|<\/root>/g, '')

    return this.execute('selectCmDeviceExt', 'SelectCmDevice', content)
  }

  async selectCmDeviceExt (devices) {
    const builder = new xml2js.Builder({ headless: true })

    const payload = {
      'soap:StateInfo': '',
      'soap:CmSelectionCriteria': {
        'soap:MaxReturnedDevices': '1000',
        'soap:DeviceClass': 'Phone',
        'soap:Model': '255',
        'soap:Status': 'Any',
        'soap:NodeName': '',
        'soap:SelectBy': 'Name',
        'soap:SelectItems': {
          'soap:item': devices.map(item => { return { 'soap:Item': item.name } })
        },
        'soap:Protocol': 'Any',
        'soap:DownloadStatus': 'Any'
      }
    }

    const content = `
      ${builder.buildObject(payload)}
    `.replace(/<root>|<root uuid="{.{36}}">|<\/root>/g, '')

    return this.execute('selectCmDeviceExt', 'SelectCmDevice', content)
  }
}
