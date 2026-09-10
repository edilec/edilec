import {mkdir, readFile, writeFile} from "node:fs/promises"
import {resolve} from "node:path"

const sourceDirectory = resolve(process.argv[2] ?? "profile-3d-contrib")
const targetDirectory = resolve(process.argv[3] ?? "assets/profile")
const backgroundPattern = '<rect x="0" y="0" width="1280" height="850" class="fill-bg"></rect>'

const variants = [
  {
    source: "profile-green.svg",
    target: "contribution-calendar-3d.svg",
    border: "#d0d7de",
  },
  {
    source: "profile-night-green-static.svg",
    target: "contribution-calendar-3d-dark.svg",
    border: "#30363d",
  },
]

function prepare(contents, border) {
  const transparent = contents.replace(/\.fill-bg \{ fill: #[0-9a-f]+; \}/i, ".fill-bg { fill: none; }")
  const frame = `<rect x="1" y="1" width="1278" height="848" rx="18" fill="none" stroke="${border}" stroke-width="2"></rect>`
  const result = transparent.replace(backgroundPattern, frame)
  if (result === contents || result.includes(backgroundPattern))
    throw new Error("The 3D calendar format changed; refusing to write an unframed asset")
  return result
}

await mkdir(targetDirectory, {recursive: true})
for (const variant of variants) {
  const contents = await readFile(resolve(sourceDirectory, variant.source), "utf8")
  await writeFile(resolve(targetDirectory, variant.target), prepare(contents, variant.border))
}

console.log(JSON.stringify({files: variants.map(variant => variant.target)}))
