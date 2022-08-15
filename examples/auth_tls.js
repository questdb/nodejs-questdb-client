const { TLSSocket } = require("tls")
const { Crypto } = require("node-webcrypto-ossl")

const client = new TLSSocket()
const crypto = new Crypto()

const HOST = "localhost"
const PORT = 9009

const JWK = {
  kid: "testUser1",
  kty: "EC",
  d: "5UjEMuA0Pj5pjK8a-fa24dyIf-Es5mYny3oE_Wmus48",
  crv: "P-256",
  x: "fLKYEaoEb9lrn3nkwLDA-M_xnuFOdSt9y0Z7_vWSHLU",
  y: "Dt5tbS1dEDMSYfym3fgMv0B99szno-dFc1rYF9t0aac",
}

async function write(data) {
  return new Promise((resolve) => {
    client.write(data, () => {
      resolve()
    })
  })
}

async function authenticate(challenge) {
  // Check for trailing \\n which ends the challenge
  if (challenge.slice(-1).readInt8() === 10) {
    const apiKey = await crypto.subtle.importKey(
      "jwk",
      JWK,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    )

    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      apiKey,
      challenge.slice(0, challenge.length - 1),
    )

    await write(`${Buffer.from(signature).toString("base64")}\n`)

    return true
  }

  return false
}

async function sendData() {
  const now = Date.now()
  await write(`test,location=us temperature=22.4 ${now * 1e6}`)
  await write(`test,location=us temperature=21.4 ${now * 1e6}`)
}

async function run() {
  let authenticated = false
  let data

  client.on("data", async function (raw) {
    data = !data ? raw : Buffer.concat([data, raw])

    if (!authenticated) {
      authenticated = await authenticate(data)
      await sendData()
      setTimeout(() => {
        client.destroy()
      }, 0)
    }
  })

  client.on("ready", async function () {
    await write(JWK.kid)
  })

  client.connect(PORT, HOST)
}

run()
