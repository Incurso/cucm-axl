import { stdout } from 'process'

export const print = (data) => {
  stdout.clearLine()
  stdout.cursorTo(0)

  stdout.write(`${data}\n`)
}

export default print
