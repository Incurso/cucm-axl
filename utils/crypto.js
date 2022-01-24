import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import parseArgs from 'minimist'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const args = parseArgs(process.argv.slice(2))

// Load config file
const config = yaml.load(await fs.readFile(path.resolve(args.config || './config/config.yml'), 'utf8')).CRYPTO

export const getNewIV = () => randomBytes(16).toString('base64')

export const encrypt = (text) => {
  const cipher = createCipheriv(config.ALGORITHM, config.SECRETKEY, Buffer.from(config.IV, 'base64'))

  const encrypted = Buffer.concat([cipher.update(text), cipher.final()])

  return encrypted.toString('base64')
}

export const decrypt = (hash) => {
  const decipher = createDecipheriv(config.ALGORITHM, config.SECRETKEY, Buffer.from(config.IV, 'base64'))

  const decrpyted = Buffer.concat([decipher.update(Buffer.from(hash, 'base64')), decipher.final()])

  return decrpyted.toString()
}

export default {
  decrypt,
  encrypt,
  getNewIV
}
