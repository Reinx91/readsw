import "dotenv/config"
import Color from "./lib/color.js"
import serialize, { Client, getContentType } from "./lib/serialize.js"
import * as Func from "./lib/function.js"

import makeWASocket, { delay, useMultiFileAuthState, fetchLatestWaWebVersion, makeInMemoryStore, jidNormalizedUser, PHONENUMBER_MCC, DisconnectReason } from "@whiskeysockets/baileys"
import pino from "pino"
import { Boom } from "@hapi/boom"
import fs from "fs"
import util from "util"
import { exec } from "child_process"

const logger = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` }).child({ class: "hisoka" })
logger.level = "fatal"

const usePairingCode = process.env.PAIRING_NUMBER

const store = makeInMemoryStore({ logger })
store.readFromFile("./session/store.json")

const startSock = async () => {
   const { state, saveCreds } = await useMultiFileAuthState("./session")
   const { version, isLatest } = await fetchLatestWaWebVersion()

   console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

   const hisoka = makeWASocket.default({
      version,
      logger,
      printQRInTerminal: !usePairingCode,
      auth: state,
      browser: ['Chrome (Linux)', '', ''],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: true,
      getMessage
   })

   store.bind(hisoka.ev)
   await Client({ hisoka, store })

   // login dengan pairing
   if (usePairingCode && !hisoka.authState.creds.registered) {
      let phoneNumber = usePairingCode.replace(/[^0-9]/g, '')

      if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) throw "Start with your country's WhatsApp code, Example : 62xxx"

      await delay(3000)
      let code = await hisoka.requestPairingCode(phoneNumber)
      console.log(`\x1b[32m${code?.match(/.{1,4}/g)?.join("-") || code}\x1b[39m`)
   }

   // ngewei info, restart or close
   hisoka.ev.on("connection.update", (update) => {
      const { lastDisconnect, connection, qr } = update
      if (connection) {
         console.info(`Connection Status : ${connection}`)
      }

      if (connection === "close") {
         let reason = new Boom(lastDisconnect?.error)?.output.statusCode

         switch (reason) {
            case DisconnectReason.badSession:
               console.info(`Bad Session File, Restart Required`)
               startSock()
               break
            case DisconnectReason.connectionClosed:
               console.info("Connection Closed, Restart Required")
               startSock()
               break
            case DisconnectReason.connectionLost:
               console.info("Connection Lost from Server, Reconnecting...")
               startSock()
               break
            case DisconnectReason.connectionReplaced:
               console.info("Connection Replaced, Restart Required")
               startSock()
               break
            case DisconnectReason.restartRequired:
               console.info("Restart Required, Restarting...")
               startSock()
               break
            case DisconnectReason.loggedOut:
               console.error("Device has Logged Out, please rescan again...")
               fs.rmdirSync("./session")
               break
            case DisconnectReason.multideviceMismatch:
               console.error("Nedd Multi Device Version, please update and rescan again...")
               fs.rmdirSync("./session")
               break
            default:
               console.log("Aku ra ngerti masalah opo iki")
               process.exit(1)
         }
      }

      if (connection === "open") {
         hisoka.sendMessage(jidNormalizedUser(hisoka.user.id), { text: `${hisoka.user?.name} has Connected...` })
      }
   })

   // write session kang
   hisoka.ev.on("creds.update", saveCreds)

   // add contacts update to store
   hisoka.ev.on("contacts.update", (update) => {
      for (let contact of update) {
         let id = jidNormalizedUser(contact.id)
         if (store && store.contacts) store.contacts[id] = { id, ...(contact || {}), ...(store.contacts?.[id] || {}) }
      }
   })

   // add contacts upsert to store
   hisoka.ev.on("contacts.upsert", (update) => {
      for (let contact of update) {
         let id = jidNormalizedUser(contact.id)
         if (store && store.contacts) store.contacts[id] = { id, ...(contact || {}), ...(store.contacts?.[id] || {}) }
      }
   })

   // nambah perubahan grup ke store
   hisoka.ev.on("groups.update", (updates) => {
      for (const update of updates) {
         const id = update.id
         if (store.groupMetadata[id]) {
            store.groupMetadata[id] = { ...(store.groupMetadata[id] || {}), ...(update || {}) }
         }
      }
   })

   // merubah status member
   hisoka.ev.on('group-participants.update', ({ id, participants, action }) => {
      const metadata = store.groupMetadata[id]
      if (metadata) {
         switch (action) {
            case 'add':
            case "revoked_membership_requests":
               metadata.participants.push(...participants.map(id => ({ id: jidNormalizedUser(id), admin: null })))
               break
            case 'demote':
            case 'promote':
               for (const participant of metadata.participants) {
                  let id = jidNormalizedUser(participant.id)
                  if (participants.includes(id)) {
                     participant.admin = (action === "promote" ? "admin" : null)
                  }
               }
               break
            case 'remove':
               metadata.participants = metadata.participants.filter(p => !participants.includes(jidNormalizedUser(p.id)))
               break
         }
      }
   })

   // bagian pepmbaca status ono ng kene
   hisoka.ev.on("messages.upsert", async ({ messages }) => {
      if (!messages[0].message) return
      let m = await serialize(hisoka, messages[0], store)
      try {
         // untuk membaca pesan status
         if (m.key && !m.key.fromMe && m.key.remoteJid === "status@broadcast") {
            if (m.type === "protocolMessage" && m.message.protocolMessage.type === 0) return
            await hisoka.readMessages([m.key])
            await hisoka.sendMessage(jidNormalizedUser(hisoka.user.id), { text: `Read Story @${m.key.participant.split("@")[0]}`, mentions: [m.key.participant] }, { quoted: m, ephemeralExpiration: m.expiration })
         }

         // nambah semua metadata ke store
         if (store.groupMetadata && Object.keys(store.groupMetadata).length === 0) store.groupMetadata = await hisoka.groupFetchAllParticipating()

         let quoted = m.isQuoted ? m.quoted : m
         let downloadM = async (filename) => await hisoka.downloadMediaMessage(quoted, filename)

         // status self apa publik
         if (process.env.PUBLIC !== true && !m.isOwner) return

         // mengabaikan pesan dari bot
         if (m.isBot) return

         // memunculkan ke log
         if (m.message && !m.isBot) {
            console.log(Color.black(Color.bgWhite("FROM")), Color.black(Color.bgGreen(m.pushName)), Color.black(Color.yellow(m.sender)) + "\n" + Color.black(Color.bgWhite("IN")), Color.black(Color.bgGreen(m.isGroup ? "Group" : "Private")) + "\n" + Color.black(Color.bgWhite("MESSAGE")), Color.black(Color.bgGreen(m.body || m.type)))
         }

         // command
         switch (m.command) {
            case "info": {
               let os = (await import("os")).default
               let v8 = (await import("v8")).default
               let { performance } = (await import("perf_hooks")).default
               let eold = performance.now()

               const used = process.memoryUsage()
               const cpus = os.cpus().map(cpu => {
                  cpu.total = Object.keys(cpu.times).reduce((last, type) => last + cpu.times[type], 0)
                  return cpu
               })
               const cpu = cpus.reduce((last, cpu, _, { length }) => {
                  last.total += cpu.total
                  last.speed += cpu.speed / length
                  last.times.user += cpu.times.user
                  last.times.nice += cpu.times.nice
                  last.times.sys += cpu.times.sys
                  last.times.idle += cpu.times.idle
                  last.times.irq += cpu.times.irq
                  return last
               }, {
                  speed: 0,
                  total: 0,
                  times: {
                     user: 0,
                     nice: 0,
                     sys: 0,
                     idle: 0,
                     irq: 0
                  }
               })
               let heapStat = v8.getHeapStatistics()
               let neow = performance.now()

               let teks = `
*Ping :* *_${Number(neow - eold).toFixed(2)} milisecond(s)_*

💻 *_Info Server_*
*- Hostname :* ${(os.hostname() || hisoka.user?.name)}
*- Platform :* ${os.platform()}
*- OS :* ${os.version()} / ${os.release()}
*- Arch :* ${os.arch()}
*- RAM :* ${Func.formatSize(os.totalmem() - os.freemem(), false)} / ${Func.formatSize(os.totalmem(), false)}

*_Runtime OS_*
${Func.runtime(os.uptime())}

*_Runtime Bot_*
${Func.runtime(process.uptime())}

*_NodeJS Memory Usage_*
${Object.keys(used).map((key, _, arr) => `*- ${key.padEnd(Math.max(...arr.map(v => v.length)), ' ')} :* ${Func.formatSize(used[key])}`).join('\n')}
*- Heap Executable :* ${Func.formatSize(heapStat?.total_heap_size_executable)}
*- Physical Size :* ${Func.formatSize(heapStat?.total_physical_size)}
*- Available Size :* ${Func.formatSize(heapStat?.total_available_size)}
*- Heap Limit :* ${Func.formatSize(heapStat?.heap_size_limit)}
*- Malloced Memory :* ${Func.formatSize(heapStat?.malloced_memory)}
*- Peak Malloced Memory :* ${Func.formatSize(heapStat?.peak_malloced_memory)}
*- Does Zap Garbage :* ${Func.formatSize(heapStat?.does_zap_garbage)}
*- Native Contexts :* ${Func.formatSize(heapStat?.number_of_native_contexts)}
*- Detached Contexts :* ${Func.formatSize(heapStat?.number_of_detached_contexts)}
*- Total Global Handles :* ${Func.formatSize(heapStat?.total_global_handles_size)}
*- Used Global Handles :* ${Func.formatSize(heapStat?.used_global_handles_size)}
${cpus[0] ? `

*_Total CPU Usage_*
${cpus[0].model.trim()} (${cpu.speed} MHZ)\n${Object.keys(cpu.times).map(type => `*- ${(type + '*').padEnd(6)}: ${(100 * cpu.times[type] / cpu.total).toFixed(2)}%`).join('\n')}

*_CPU Core(s) Usage (${cpus.length} Core CPU)_*
${cpus.map((cpu, i) => `${i + 1}. ${cpu.model.trim()} (${cpu.speed} MHZ)\n${Object.keys(cpu.times).map(type => `*- ${(type + '*').padEnd(6)}: ${(100 * cpu.times[type] / cpu.total).toFixed(2)}%`).join('\n')}`).join('\n\n')}` : ''}
`.trim()
               await m.reply(teks)
            }
               break

            case "quoted": case "q":
               if (!m.isQuoted) throw "Reply Pesan"
               try {
                  var message = await serialize(hisoka, (await store.loadMessage(m.from, m.quoted.id)), store)
                  if (!message.isQuoted) throw "Pesan quoted gaada"
                  await m.reply({ forward: message.quoted })
               } catch (e) {
                  throw "Pesan gaada"
               }
               break

            case "rvo":
               if (!quoted.msg.viewOnce) throw "Reply Pesan Sekali Lihat"
               quoted.msg.viewOnce = false
               await m.reply({ forward: quoted })
               break

            case "getsw": case "sw": {
               if (!store.messages["status@broadcast"].array.length === 0) throw "Gaada 1 status pun"
               let contacts = Object.values(store.contacts)
               let [who, value] = m.text.split(/[,|\-+&]/)
               value = value?.replace(/\D+/g, "")

               let sender
               if (m.mentions.length !== 0) sender = m.mentions[0]
               else if (m.text) sender = contacts.find(v => [v.name, v.verifiedName, v.notify].some(name => name && name.toLowerCase().includes(who.toLowerCase())))?.id

               let stories = store.messages["status@broadcast"].array
               let story = stories.filter(v => v.key && v.key.participant === sender || v.participant === sender).filter(v => v.message && v.message.protocolMessage?.type !== 0)
               if (story.length === 0) throw "Gaada sw nya"
               if (value) {
                  if (story.length < value) throw "Jumlahnya ga sampe segitu"
                  await m.reply({ forward: story[value - 1] })
               } else {
                  for (let msg of story) {
                     await delay(2000)
                     await m.reply({ forward: msg })
                  }
               }
            }
               break

            case "listsw": {
               if (!store.messages["status@broadcast"].array.length === 0) throw "Gaada 1 status pun"
               let stories = store.messages["status@broadcast"].array
               let story = stories.filter(v => v.message && v.message.protocolMessage?.type !== 0)
               if (story.length === 0) throw "Status gaada"
               const result = {}
               story.forEach(obj => {
                  let participant = obj.key.participant || obj.participant
                  if (!result[participant]) {
                     result[participant] = []
                  }
                  result[participant].push(obj)
               })
               let type = (mType) => getContentType(mType) === "extendedTextMessage" ? "text" : getContentType(mType).replace("Message", "")
               let text = ""
               for (let id of Object.keys(result)) {
                  if (!id) return
                  text += `*- ${await hisoka.getName(id)}*\n`
                  text += `${result[id].map((v, i) => `${i + 1}. ${type(v.message)}`).join("\n")}\n\n`
               }
               await m.reply(text.trim(), { mentions: Object.keys(result) })
            }
               break

            case "upsw":
               let statusJidList = Object.keys(store.contacts)
               let colors = [0xff26c4dc, 0xff792138, 0xff8b6990, 0xfff0b330, 0xffae8774, 0xff5696ff, 0xffff7b6b, 0xff57c9ff, 0xff243640, 0xffb6b327, 0xffc69fcc, 0xff54c265, 0xff6e257e, 0xffc1a03f, 0xff90a841, 0xff7acba5, 0xff8294ca, 0xffa62c71, 0xffff8a8c, 0xff7e90a3, 0xff74676a]
               if (!quoted.isMedia) {
                  let text = m.text || m.quoted?.body || ""
                  if (!text) throw "Mana text?"
                  await hisoka.sendMessage("status@broadcast", { text }, {
                     backgroundColor: colors[Math.floor(Math.random() * colors.length)],
                     textArgb: 0xffffffff,
                     font: Math.floor(Math.random() * 9),
                     statusJidList
                  })
               } else if (/audio/.test(quoted.msg.mimetype)) {
                  await hisoka.sendMessage("status@broadcast", {
                     audio: await downloadM(),
                     mimetype: 'audio/mp4',
                     ptt: true
                  }, { backgroundColor: colors[Math.floor(Math.random() * colors.length)], statusJidList })
               } else {
                  let type = /image/.test(quoted.msg.mimetype) ? "image" : /video/.test(quoted.msg.mimetype) ? "video" : false
                  if (!type) throw "Type tidak didukung"
                  await hisoka.sendMessage("status@broadcast", {
                     [`${type}`]: await downloadM(),
                     caption: m.text || m.quoted?.body || ""
                  }, { statusJidList })
               }
               break

            case "sticker": case "s":
               if (/image|video|webp/.test(quoted.msg.mimetype)) {
                  let media = await downloadM()
                  if (quoted.msg?.seconds > 10) throw "Video diatas durasi 10 detik gabisa"
                  let exif
                  if (m.text) {
                     let [packname, author] = m.text.split(/[,|\-+&]/)
                     exif = { packName: packname ? packname : "", packPublish: author ? author : "" }
                  } else {
                     exif = { packName: `Sticker Dibuat Oleh : `, packPublish: `Dika Ardianta` }
                  }

                  let sticker = await (await import("./lib/sticker.js")).writeExif({ mimetype: quoted.msg.mimetype, data: media }, exif)
                  await m.reply({ sticker })
               } else if (m.mentions.length !== 0) {
                  for (let id of m.mentions) {
                     await delay(1500)
                     let url = await hisoka.profilePictureUrl(id, "image")
                     let media = await Func.fetchBuffer(url)
                     let sticker = await (await import("./lib/sticker.js")).writeExif(media, { packName: `Sticker Dibuat Oleh : `, packPublish: `Dika Ardianta` })
                     await m.reply({ sticker })
                  }
               } else if (/(https?:\/\/.*\.(?:png|jpg|jpeg|webp|mov|mp4|webm|gif))/i.test(m.text)) {
                  for (let url of Func.isUrl(m.text)) {
                     await delay(1500)
                     let media = await Func.fetchBuffer(url)
                     let sticker = await (await import("./lib/sticker.js")).writeExif(media, { packName: `Sticker Dibuat Oleh : `, packPublish: `Dika Ardianta` })
                     await m.reply({ sticker })
                  }
               } else {
                  let media = await Func.fetchBuffer("https://www.hlapi.cn/api/mcj")
                  let sticker = await (await import("./lib/sticker.js")).writeExif(media, { packName: `Sticker Dibuat Oleh : `, packPublish: `Dika Ardianta` })
                  await m.reply({ sticker })
               }
               break

            case "exif":
               let webp = (await import("node-webpmux")).default
               let img = new webp.Image()
               await img.load(await downloadM())
               await m.reply(util.format((JSON.parse(img.exif.slice(22).toString()))))
               break

            case "tourl":
               if (!quoted.isMedia) throw "Reply pesan media"
               if (Number(quoted.msg?.fileLength) > 350000000) throw "Kegeden mas"
               let media = await downloadM()
               let url = (/image|video/i.test(quoted.msg.mimetype) && !/webp/i.test(quoted.msg.mimetype)) ? await Func.upload.telegra(media) : await Func.upload.pomf(media)
               await m.reply(url)
               break

            case "link":
               if (!m.isGroup && !m.isBotAdmin) throw "Gabisa, kalo ga karena bot bukan admin ya karena bukan grup"
               await m.reply("https://chat.whatsapp.com/" + (m.metadata?.inviteCode || await hisoka.groupInviteCode(m.from)))
               break

            case "delete": case "del":
               if (quoted.fromMe) {
                  await hisoka.sendMessage(m.from, { delete: quoted.key })
               } else {
                  if (!m.isBotAdmin) throw "Bot bukan admin"
                  if (!m.isAdmin) throw "Lhu bukan admin paok 😂"
                  await hisoka.sendMessage(m.from, { delete: quoted.key })
               }
               break

            default:
               // eval
               if ([">", "eval", "=>"].some(a => m.body?.toLowerCase()?.startsWith(a)) && m.isOwner) {
                  let evalCmd = ""
                  try {
                     evalCmd = /await/i.test(m.text) ? eval("(async() => { " + m.text + " })()") : eval(m.text)
                  } catch (e) {
                     evalCmd = e
                  }
                  new Promise(async (resolve, reject) => {
                     try {
                        resolve(evalCmd);
                     } catch (err) {
                        reject(err)
                     }
                  })
                     ?.then((res) => m.reply(util.format(res)))
                     ?.catch((err) => m.reply(util.format(err)))
               }

               // exec
               if (["$", "exec"].some(a => m.body?.toLowerCase()?.startsWith(a)) && m.isOwner) {
                  try {
                     exec(m.text, async (err, stdout) => {
                        if (err) return m.reply(util.format(err))
                        if (stdout) return m.reply(util.format(stdout))
                     })
                  } catch (e) {
                     await m.reply(util.format(e))
                  }
               }
         }
      } catch (err) {
         await m.reply(util.format(err))
      }
   })

   setInterval(() => {
      store.writeToFile("./session/store.json")
   }, 10 * 1000) // tiap 10 detik

   process.on("uncaughtException", console.error)
   process.on("unhandledRejection", console.error)
}

// opsional
async function getMessage(key) {
   try {
      const jid = jidNormalizedUser(key.remoteJid)
      const msg = await store.loadMessage(jid, key.id)

      return msg?.message || ""

      return ""
   } catch { }
}

startSock()
