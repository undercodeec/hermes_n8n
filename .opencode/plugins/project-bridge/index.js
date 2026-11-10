import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"

const ROOTS = {
  undercode: "D:/Documentos/undercodeec_nextjs",
  hermes: "D:/Documentos/Hermes",
}
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BRIDGE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OpenCode", "undercode-hermes-bridge-v1")
const normalize = (value) => path.win32.normalize(value).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()
const peerOf = (project) => project === "undercode" ? "hermes" : "undercode"
const messageDir = (project) => path.join(BRIDGE, project)
const messageFile = (project, id) => path.join(messageDir(project), `${id}.json`)
const ackFile = (project, id) => path.join(BRIDGE, "acks", project, `${id}.json`)

function projectAt(directory) {
  const project = Object.keys(ROOTS).find((name) => normalize(ROOTS[name]) === normalize(directory))
  if (!project) throw new Error("Project Bridge solo funciona desde las raíces Git UnderCodeEC y Hermes")
  const real = fs.realpathSync.native(ROOTS[project])
  const git = execFileSync("git", ["-C", ROOTS[project], "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true }).trim()
  if (normalize(real) !== normalize(ROOTS[project]) || normalize(git) !== normalize(ROOTS[project])) {
    throw new Error("La ruta o raíz Git del proyecto cambió")
  }
  return project
}

function gitState(project) {
  const cwd = ROOTS[project]
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim()
  return {
    branch: git("branch", "--show-current"),
    head: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
  }
}

function bounded(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} debe tener entre 1 y ${max} caracteres`)
  return value.trim()
}

function validID(id) {
  if (typeof id !== "string" || !MESSAGE_ID.test(id)) throw new Error("ID de mensaje inválido")
  return id.toLowerCase()
}

async function writeAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", encoding: "utf8" })
    await fsp.rename(temporary, file)
  } finally {
    await fsp.rm(temporary, { force: true })
  }
}

async function loadMessage(project, id) {
  const key = validID(id)
  const value = JSON.parse(await fsp.readFile(messageFile(project, key), "utf8"))
  if (value.schema !== 1 || value.id !== key || value.to !== project || value.from !== peerOf(project)) throw new Error("Mensaje del puente inválido")
  return value
}

async function acknowledged(project, id) {
  try {
    await fsp.access(ackFile(project, id))
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

async function send(project, input) {
  const taskId = bounded(input.taskId, "taskId", 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) throw new Error("taskId solo admite letras, números, punto, guion y guion bajo")
  const subject = bounded(input.subject, "subject", 160)
  const body = bounded(input.body, "body", 12000)
  const message = {
    schema: 1,
    id: randomUUID(),
    from: project,
    to: peerOf(project),
    taskId,
    subject,
    body,
    source: gitState(project),
    sentAt: new Date().toISOString(),
  }
  await writeAtomic(messageFile(message.to, message.id), message)
  return { id: message.id, to: message.to, taskId, sentAt: message.sentAt, source: message.source }
}

async function list(project, input) {
  const mailbox = input.mailbox || "inbox"
  if (!["inbox", "outbox"].includes(mailbox)) throw new Error("mailbox debe ser inbox u outbox")
  const destination = mailbox === "inbox" ? project : peerOf(project)
  const limit = input.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit debe estar entre 1 y 50")
  let names
  try {
    names = await fsp.readdir(messageDir(destination))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const messages = []
  for (const name of names) {
    if (!MESSAGE_ID.test(name.slice(0, -5)) || !name.endsWith(".json")) continue
    const item = await loadMessage(destination, name.slice(0, -5))
    if (mailbox === "outbox" && item.from !== project) continue
    const acked = await acknowledged(destination, item.id)
    if (mailbox === "inbox" && acked && !input.includeAcknowledged) continue
    messages.push({ id: item.id, taskId: item.taskId, subject: item.subject, from: item.from, to: item.to, sentAt: item.sentAt, source: item.source, acknowledged: acked })
  }
  return messages.sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, limit)
}

async function read(project, input) {
  const item = await loadMessage(project, input.id)
  return { ...item, acknowledged: await acknowledged(project, item.id) }
}

async function acknowledge(project, input) {
  const item = await loadMessage(project, input.id)
  const note = input.note === undefined ? undefined : bounded(input.note, "note", 240)
  const ack = { id: item.id, taskId: item.taskId, by: project, acknowledgedAt: new Date().toISOString(), ...(note ? { note } : {}) }
  if (!(await acknowledged(project, item.id))) await writeAtomic(ackFile(project, item.id), ack)
  return { id: item.id, acknowledged: true }
}

const result = (value) => ({ content: JSON.stringify(value) })

export default {
  id: "undercode.hermes.project-bridge",
  async setup(ctx) {
    if (!ctx.app.version.startsWith("2.")) throw new Error("Project Bridge requiere OpenCode V2")
    const project = projectAt(ctx.location.directory)
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "project_bridge", description: "Handoffs locales entre UnderCodeEC y Hermes, sin acceso cruzado a código" })
      editor.add({
        name: "send",
        description: "Envía un handoff al otro proyecto. Incluye tarea, asunto, resumen, rama y HEAD; no envíes secretos ni datos productivos.",
        input: { type: "object", properties: { taskId: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["taskId", "subject", "body"], additionalProperties: false },
        options: { namespace: "project_bridge" },
        execute: async (input) => result(await send(project, input)),
      })
      editor.add({
        name: "list",
        description: "Lista el buzón entrante o el estado del buzón saliente. No abre archivos del otro repositorio.",
        input: { type: "object", properties: { mailbox: { type: "string", enum: ["inbox", "outbox"] }, limit: { type: "integer", minimum: 1, maximum: 50 }, includeAcknowledged: { type: "boolean" } }, additionalProperties: false },
        options: { namespace: "project_bridge" },
        execute: async (input) => result(await list(project, input)),
      })
      editor.add({
        name: "read",
        description: "Lee por ID un handoff recibido por este proyecto.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        options: { namespace: "project_bridge" },
        execute: async (input) => result(await read(project, input)),
      })
      editor.add({
        name: "ack",
        description: "Confirma la recepción de un handoff entrante; no inicia trabajo ni concede permisos.",
        input: { type: "object", properties: { id: { type: "string" }, note: { type: "string" } }, required: ["id"], additionalProperties: false },
        options: { namespace: "project_bridge" },
        execute: async (input) => result(await acknowledge(project, input)),
      })
    })
    await ctx.command.transform((editor) => {
      editor.add({
        name: project === "undercode" ? "enviar-hermes" : "enviar-undercode",
        description: "Envía un mensaje al otro proyecto: ID | Asunto | Mensaje",
        execute: async ({ sessionID, prompt }) => {
          const parts = String(prompt?.text || "").trim().split("|").map((part) => part.trim())
          if (parts.length !== 3) throw new Error("Uso: /enviar-<proyecto> ID | Asunto | Mensaje")
          const sent = await send(project, { taskId: parts[0], subject: parts[1], body: parts[2] })
          await ctx.session.synthetic({ sessionID, text: `Mensaje enviado a ${sent.to}. ID: ${sent.id}. Tarea: ${sent.taskId}.` })
        },
      })
      editor.add({
        name: "buzon-proyectos",
        description: "Muestra los mensajes pendientes del otro proyecto",
        execute: async ({ sessionID }) => {
          const messages = await list(project, { mailbox: "inbox" })
          const lines = messages.map((item) => `${item.id} | ${item.taskId} | ${item.subject} | ${item.from} | ${item.sentAt}`)
          await ctx.session.synthetic({ sessionID, text: lines.length ? `Mensajes pendientes:\n${lines.join("\n")}` : "No hay mensajes pendientes." })
        },
      })
    })
  },
}
