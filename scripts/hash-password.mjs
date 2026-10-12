#!/usr/bin/env node
// Usage: npm run hash-password            (prompts, input hidden)
//        npm run hash-password -- 'secret' (non-interactive; ends up in shell history)
// Prints OPERATOR_PASSWORD_HASH=scrypt$... for .env.local or your cloud secrets.
import { randomBytes, scryptSync } from "node:crypto"
import readline from "node:readline"

function hash(password) {
  const N = 16384, r = 8, p = 1
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 32, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`
}

async function prompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  rl._writeToOutput = (text) => { if (text.includes("Password")) rl.output.write(text) }
  const answer = await new Promise((resolve) => rl.question("Password: ", resolve))
  rl.close()
  process.stdout.write("\n")
  return answer
}

const password = process.argv[2] ?? (await prompt())
if (!password || password.length < 10) {
  console.error("Use at least 10 characters.")
  process.exit(1)
}
console.log(`OPERATOR_PASSWORD_HASH=${hash(password)}`)
