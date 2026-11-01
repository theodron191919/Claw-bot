const fs = require("node:fs/promises");
const path = require("node:path");

const root = process.env.SECURITY_DATA_DIR || path.join(process.cwd(), "data");

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(name, value) {
  await fs.mkdir(root, { recursive: true });
  const destination = path.join(root, name);
  const temporary = destination + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, destination);
}

module.exports = { root, readJson, writeJson, durable: root.startsWith("/data/") };
