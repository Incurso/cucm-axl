import fs from 'fs'
import path from 'path'
import cliProgress from 'cli-progress'
import chalk from 'chalk'
import yaml from 'js-yaml'
import parseArgs from 'minimist'
import pg from 'pg'
import { start } from 'repl'
import Excel from 'exceljs'

//import AXL from './utils/cucm-axl.js'

//const axl = new AXL()

const args = parseArgs(process.argv.slice(2))

console.log(args)

const startDate = args['start-date']
  ? new Date(args['start-date'])
  : new Date(new Date().setHours(0, 0, 0, 0))

// Check if start-date is valid
if (startDate.toString() === 'Invalid Date') {
  throw new Error('Invalid start-date')
}

//d.setHours(24,0,0,0)
const endDate = args['end-date']
  ? new Date(args['end-date'])
  : new Date(new Date().setHours(24, 0, 0, 0))

// Check if end-date is valid
if (endDate.toString() === 'Invalid Date') {
  throw new Error('Invalid end-date')
}

const interval = args['interval'] || 'day'
const dn = args['dn'] || '1800'

// Load config file
const config = yaml.load(fs.readFileSync(path.resolve(args.config || './config/config.yml'), 'utf8')).CDR_REPORT

//console.log(config)

const client = new pg.Client({
  host: config.HOST,
  user: config.USER,
  password: config.PASS,
  database: config.DB
})

const saveToExcel = async (data) => {
  console.log(data.rows)

  const fileName = `${dn}_${startDate.toISOString().slice(0, 10).replace(/-/g, '')}-${endDate.toISOString().slice(0, 10).replace(/-/g, '')}.xlsx`
  const workbook = new Excel.Workbook()
  const worksheet = workbook.addWorksheet(dn.toString())

  worksheet.columns = [
    { width: 18 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
    { width: 12 },
  ]

  worksheet.getCell('A1').value = `Number: ${dn}`
  worksheet.getCell('A2').value = `Start Date: ${startDate.toISOString().slice(0, 16).replace(/T/g, ' ')}`
  worksheet.getCell('A3').value = `End Date: ${endDate.toISOString().slice(0, 16).replace(/T/g, ' ')}`

  worksheet.addTable({
    name: 'Number',
    ref: 'A4',
    headerRow: true,
    totalsRow: true,
    style: {
      theme: 'TableStyleMedium2',
      showRowStripes: true,
    },
    columns: [
      { name: 'DateTime', totalsRowLabel: 'Totals:', filterButton: true },
      { name: 'Total', totalsRowFunction: 'sum', filterButton: false },
      { name: 'Answered', totalsRowFunction: 'sum', filterButton: false },
      { name: 'Forwarded To', totalsRowFunction: 'sum', filterButton: false },
      { name: 'Forwarded From', totalsRowFunction: 'sum', filterButton: false },
      { name: 'Unanswered', totalsRowFunction: 'sum', filterButton: false },
    ],
    rows: data.rows.map(row => Object.values(row).map(i => !isNaN(i) ? parseInt(i) : i)),
  });

  await workbook.xlsx.writeFile(fileName)
}

await client.connect()
  .then(() => console.log('connected'))
  .catch((err) => console.error('connection error', err.stack))

const query = `
  SELECT
    d.date || ' ' || RIGHT('0' || ${interval === 'hour' ? `d.${interval}` : '0'}, 2) || ':00:00' AS datetime,
    SUM(d.total) AS total,
    SUM(d.answered_direct) AS answered_direct,
    SUM(d.forwarded_to) AS forwarded_to,
    SUM(d.forwarded_from) AS forwarded_from,
    SUM(d.unanswered) AS unanswered
  FROM (
    (SELECT
      CAST(to_timestamp(dateTimeOrigination) AS DATE) AS date,
      date_part('${interval}', to_timestamp(dateTimeOrigination)) AS ${interval},
      COUNT(*) AS total,
      COUNT(
        CASE WHEN
          duration > 0
          AND originalCalledPartyNumber = finalCalledPartyNumber
        THEN globalCallID_callId END) AS answered_direct,
      COUNT(
        CASE WHEN
          duration > 0
          AND originalCalledPartyNumber NOT IN ('${dn}', '543${dn}', '0543${dn}', '+354543${dn}')
          AND finalCalledPartyNumber IN ('${dn}', '543${dn}', '0543${dn}', '+354543${dn}')
          AND finalCalledPartyNumber NOT IN (${Array.from(Array(30).keys()).map(i => `'100900${i < 10 ? `0${i}` : i}'`).join(',')})
        THEN globalCallID_callId END) AS forwarded_to,
      COUNT(
        CASE WHEN
          duration > 0
          AND originalCalledPartyNumber IN ('${dn}', '543${dn}', '0543${dn}', '+354543${dn}')
          AND finalCalledPartyNumber NOT IN ('${dn}', '543${dn}', '0543${dn}', '+354543${dn}')
          AND finalCalledPartyNumber NOT IN (${Array.from(Array(30).keys()).map(i => `'100900${i < 10 ? `0${i}` : i}'`).join(',')})
        THEN globalCallID_callId END) AS forwarded_from,
      COUNT(
        CASE WHEN
          duration = 0
          OR finalCalledPartyNumber IN (${Array.from(Array(30).keys()).map(i => `'100900${i < 10 ? `0${i}` : i}'`).join(',')})
        THEN globalCallID_callId END) AS unanswered
    FROM callDetailRecords
    WHERE datetimeorigination BETWEEN ${startDate.getTime() / 1000} AND ${endDate.getTime() / 1000}
      AND (originalCalledPartyNumber IN ('${dn}', '543${dn}', '0543${dn}', '+354543${dn}') OR finalCalledPartyNumber IN ('${dn}', '543${dn}', '0543${dn}', '+354543${dn}'))
      AND originalCalledPartyNumberPartition NOT IN ('Record-Tilkynning-PT', 'record-proxy')
    GROUP BY CAST(to_timestamp(datetimeorigination) AS DATE), DATE_PART('${interval}', to_timestamp(dateTimeOrigination)))
    UNION
    (SELECT
      CAST(generate_series AS DATE) AS date,
      date_part('${interval}', generate_series) AS ${interval},
      0 AS total,
      0 AS answered_direct,
      0 AS forwarded_to,
      0 AS forwarded_from,
      0 as unanswered
    FROM generate_series('${startDate.toISOString()}'::TIMESTAMP, '${endDate.toISOString()}'::TIMESTAMP - '1 ${interval}'::INTERVAL, '1 ${interval}'::INTERVAL))
  ) AS d
  GROUP BY d.date, d.${interval}
  ORDER BY d.date, d.${interval};
`

console.log(query)

console.time('query')
await client.query(query)
  //.then((result) => console.log(result.rows))
  .then(async (result) => {
    await saveToExcel(result)
  })
  .catch((err) => console.error('query error', err.stack))
console.timeEnd('query')

await client.end()