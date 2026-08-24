import {mkdir, writeFile} from "node:fs/promises"
import {resolve} from "node:path"
import {pathToFileURL} from "node:url"

const API_ORIGIN = "https://api.github.com"
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const MAX_REPOSITORIES = 8

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

export function parseRepositories(value) {
  const repositories = [...new Set(String(value ?? "")
    .split(",")
    .map(repository => repository.trim())
    .filter(Boolean))]

  if (!repositories.length || repositories.length > MAX_REPOSITORIES)
    throw new Error(`Expected between 1 and ${MAX_REPOSITORIES} repositories`)
  for (const repository of repositories) {
    if (!REPOSITORY_PATTERN.test(repository))
      throw new Error(`Invalid repository identifier: ${repository}`)
  }
  return repositories
}

async function requestJson(path, token, {allowNotFound = false} = {}) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "edilec-public-engineering-signal",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  })
  if ((response.status === 404) && allowNotFound)
    return null
  if (!response.ok)
    throw new Error(`GitHub API request failed with status ${response.status} for ${path.split("?")[0]}`)
  return response.json()
}

export async function inspectRepository(repository, token) {
  const [owner, name] = repository.split("/")
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const metadata = await requestJson(base, token)
  const branch = metadata.default_branch

  const [release, security, workflowResult] = await Promise.all([
    requestJson(`${base}/releases/latest`, token, {allowNotFound: true}),
    requestJson(`${base}/contents/SECURITY.md?ref=${encodeURIComponent(branch)}`, token, {allowNotFound: true}),
    requestJson(`${base}/actions/workflows?per_page=100`, token, {allowNotFound: true}),
  ])

  const workflows = workflowResult?.workflows ?? []
  const ciWorkflow = workflows.find(workflow =>
    (workflow.state === "active") &&
    ((workflow.name.toLowerCase() === "ci") || /\/(ci|continuous-integration)\.(yml|yaml)$/i.test(workflow.path))
  )

  let ci = "missing"
  if (ciWorkflow) {
    const runs = await requestJson(
      `${base}/actions/workflows/${ciWorkflow.id}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=1`,
      token,
      {allowNotFound: true},
    )
    ci = runs?.workflow_runs?.[0]?.conclusion ?? "configured"
  }

  const license = metadata.license?.spdx_id
  return {
    repository,
    name: metadata.name,
    language: metadata.language ?? "Mixed",
    license: (license && (license !== "NOASSERTION")) ? license : null,
    release: release?.tag_name ?? null,
    security: Boolean(security),
    ci,
  }
}

export function summarize(repositories) {
  return {
    total: repositories.length,
    released: repositories.filter(repository => repository.release).length,
    passing: repositories.filter(repository => repository.ci === "success").length,
    secured: repositories.filter(repository => repository.security).length,
    licensed: repositories.filter(repository => repository.license).length,
  }
}

function palette(theme) {
  return theme === "dark"
    ? {
      background: "#0d1117",
      panel: "#161b22",
      border: "#30363d",
      text: "#f0f6fc",
      muted: "#8c959f",
      accent: "#56d364",
      accentText: "#7ee787",
      accentSoft: "#12261e",
      warning: "#d29922",
    }
    : {
      background: "#f6f8fa",
      panel: "#ffffff",
      border: "#d0d7de",
      text: "#1f2328",
      muted: "#57606a",
      accent: "#1f883d",
      accentText: "#116329",
      accentSoft: "#dafbe1",
      warning: "#9a6700",
    }
}

function statusBadge(x, y, width, text, good, colors) {
  const fill = good ? colors.accentSoft : colors.panel
  const stroke = good ? colors.accent : colors.warning
  const color = good ? colors.accentText : colors.warning
  return `<g><rect x="${x}" y="${y}" width="${width}" height="24" rx="12" fill="${fill}" stroke="${stroke}"/><text x="${x + width / 2}" y="${y + 16}" text-anchor="middle" fill="${color}" font-size="10" font-weight="700" letter-spacing=".8">${escapeXml(text)}</text></g>`
}

function compactStatusBadge(x, y, width, text, good, colors) {
  const fill = good ? colors.accentSoft : colors.panel
  const stroke = good ? colors.accent : colors.warning
  const color = good ? colors.accentText : colors.warning
  return `<g><rect x="${x}" y="${y}" width="${width}" height="18" rx="9" fill="${fill}" stroke="${stroke}"/><text x="${x + width / 2}" y="${y + 12.5}" text-anchor="middle" fill="${color}" font-size="8.5" font-weight="700" letter-spacing=".45">${escapeXml(text)}</text></g>`
}

export function renderMobileSignal(repositories, {theme, label, profile = "personal"}) {
  const colors = palette(theme)
  const summary = summarize(repositories)
  const rowHeight = 76
  const rowsY = 220
  const height = rowsY + repositories.length * rowHeight + 20
  const statistics = [
    ["RELEASED", summary.released],
    ["CI PASSING", summary.passing],
    ["SECURITY POLICY", summary.secured],
    ["SPDX LICENSED", summary.licensed],
  ]

  const statisticMarkup = statistics.map(([name, value], index) => {
    const x = index % 2 === 0 ? 20 : 200
    const y = index < 2 ? 104 : 160
    const good = value === summary.total
    return `<g><rect x="${x}" y="${y}" width="170" height="46" rx="12" fill="${colors.panel}" stroke="${good ? colors.border : colors.warning}"/><text x="${x + 14}" y="${y + 18}" fill="${colors.muted}" font-size="8.5" font-weight="700" letter-spacing="1">${name}</text><text x="${x + 14}" y="${y + 37}" fill="${good ? colors.accentText : colors.warning}" font-size="17" font-weight="750">${value} / ${summary.total}</text></g>`
  }).join("")

  const repositoryMarkup = repositories.map((repository, index) => {
    const y = rowsY + index * rowHeight
    const allGood = Boolean(repository.release && repository.security && repository.license && (repository.ci === "success"))
    const ciText = repository.ci === "success"
      ? "CI PASS"
      : repository.ci === "configured"
        ? "CI READY"
        : repository.ci === "missing"
          ? "NO CI"
          : `CI ${repository.ci.toUpperCase().slice(0, 8)}`
    return `<g data-repository="${escapeXml(repository.repository ?? repository.name)}" data-release="${escapeXml(repository.release ?? "none")}" data-checks="${escapeXml(repository.ci)}" data-security-policy="${repository.security}" data-license="${escapeXml(repository.license ?? "none")}">
      <rect x="20" y="${y}" width="350" height="66" rx="13" fill="${colors.panel}" stroke="${colors.border}"/>
      <circle cx="37" cy="${y + 20}" r="4" fill="${allGood ? colors.accent : colors.warning}"/>
      <text x="50" y="${y + 23}" fill="${colors.text}" font-size="13" font-weight="700">${escapeXml(repository.name)}</text>
      <text x="50" y="${y + 39}" fill="${colors.muted}" font-size="9.5">${escapeXml(repository.language)} · ${escapeXml(repository.license ?? "Licence review")}</text>
      ${compactStatusBadge(50, y + 44, 68, repository.release ?? "UNRELEASED", Boolean(repository.release), colors)}
      ${compactStatusBadge(126, y + 44, 68, ciText, repository.ci === "success", colors)}
      ${compactStatusBadge(202, y + 44, 86, repository.security ? "SECURITY" : "NO POLICY", repository.security, colors)}
    </g>`
  }).join("")

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 390 ${height}" width="390" height="${height}" role="img" aria-labelledby="signal-title signal-desc" data-component="repository-evidence" data-schema="1" data-profile="${escapeXml(profile)}" data-layout="mobile" data-signal="engineering" data-repositories="${summary.total}">
  <title id="signal-title">${escapeXml(label)} public engineering signal</title>
  <desc id="signal-desc">Current release, continuous integration, security policy, and licence status for ${summary.total} selected public repositories.</desc>
  <rect x=".5" y=".5" width="389" height="${height - 1}" rx="18" fill="${colors.background}" stroke="${colors.border}"/>
  <text x="20" y="34" fill="${colors.accentText}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="9.5" font-weight="750" letter-spacing="1.6">PUBLIC ENGINEERING SIGNAL</text>
  <text x="20" y="65" fill="${colors.text}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="20" font-weight="750">${escapeXml(label)}</text>
  <text x="20" y="86" fill="${colors.muted}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="10.5">Release, CI, security, and licence evidence.</text>
  <g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    ${statisticMarkup}
    ${repositoryMarkup}
  </g>
</svg>
`
}

export function renderSignal(repositories, {theme, label, profile = "personal", layout = "desktop"}) {
  if (layout === "mobile")
    return renderMobileSignal(repositories, {theme, label, profile})
  const colors = palette(theme)
  const summary = summarize(repositories)
  const rowHeight = 48
  const rowsY = 184
  const height = rowsY + repositories.length * rowHeight + 28
  const statisticWidth = 207
  const statisticGap = 18
  const statistics = [
    ["RELEASED", summary.released],
    ["CI PASSING", summary.passing],
    ["SECURITY POLICY", summary.secured],
    ["SPDX LICENSED", summary.licensed],
  ]

  const statisticMarkup = statistics.map(([name, value], index) => {
    const x = 36 + index * (statisticWidth + statisticGap)
    const good = value === summary.total
    return `<g><rect x="${x}" y="102" width="${statisticWidth}" height="58" rx="14" fill="${colors.panel}" stroke="${good ? colors.border : colors.warning}"/><text x="${x + 18}" y="126" fill="${colors.muted}" font-size="10" font-weight="700" letter-spacing="1.4">${name}</text><text x="${x + 18}" y="149" fill="${good ? colors.accentText : colors.warning}" font-size="21" font-weight="750">${value} / ${summary.total}</text></g>`
  }).join("")

  const repositoryMarkup = repositories.map((repository, index) => {
    const y = rowsY + index * rowHeight
    const allGood = Boolean(repository.release && repository.security && repository.license && (repository.ci === "success"))
    const ciText = repository.ci === "success"
      ? "CI PASS"
      : repository.ci === "configured"
        ? "CI READY"
        : repository.ci === "missing"
          ? "NO CI"
          : `CI ${repository.ci.toUpperCase().slice(0, 8)}`
    return `<g data-repository="${escapeXml(repository.repository ?? repository.name)}" data-release="${escapeXml(repository.release ?? "none")}" data-checks="${escapeXml(repository.ci)}" data-security-policy="${repository.security}" data-license="${escapeXml(repository.license ?? "none")}">
      <rect x="36" y="${y}" width="888" height="38" rx="12" fill="${colors.panel}" stroke="${colors.border}"/>
      <circle cx="55" cy="${y + 19}" r="4" fill="${allGood ? colors.accent : colors.warning}"/>
      <text x="70" y="${y + 17}" fill="${colors.text}" font-size="14" font-weight="700">${escapeXml(repository.name)}</text>
      <text x="70" y="${y + 30}" fill="${colors.muted}" font-size="10">${escapeXml(repository.language)} · ${escapeXml(repository.license ?? "Licence review")}</text>
      ${statusBadge(590, y + 7, 94, repository.release ?? "UNRELEASED", Boolean(repository.release), colors)}
      ${statusBadge(696, y + 7, 92, ciText, repository.ci === "success", colors)}
      ${statusBadge(800, y + 7, 108, repository.security ? "SECURITY" : "NO POLICY", repository.security, colors)}
    </g>`
  }).join("")

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${height}" width="960" height="${height}" role="img" aria-labelledby="signal-title signal-desc" data-component="repository-evidence" data-schema="1" data-profile="${escapeXml(profile)}" data-layout="desktop" data-signal="engineering" data-repositories="${summary.total}">
  <title id="signal-title">${escapeXml(label)} public engineering signal</title>
  <desc id="signal-desc">Current release, continuous integration, security policy, and licence status for ${summary.total} selected public repositories.</desc>
  <rect x=".5" y=".5" width="959" height="${height - 1}" rx="20" fill="${colors.background}" stroke="${colors.border}"/>
  <text x="36" y="40" fill="${colors.accentText}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" font-weight="750" letter-spacing="2">PUBLIC ENGINEERING SIGNAL</text>
  <text x="36" y="74" fill="${colors.text}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="24" font-weight="750">${escapeXml(label)} · maintained systems</text>
  <text x="36" y="92" fill="${colors.muted}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12">Release, CI, disclosure, and licensing evidence from an explicit repository allowlist.</text>
  <g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    ${statisticMarkup}
    ${repositoryMarkup}
  </g>
</svg>
`
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  if (!token)
    throw new Error("GITHUB_TOKEN is required")
  const repositories = parseRepositories(process.env.PROFILE_REPOSITORIES)
  const label = String(process.env.PROFILE_LABEL ?? "").trim()
  if (!label || label.length > 80)
    throw new Error("PROFILE_LABEL must contain 1-80 characters")
  const profile = String(process.env.PROFILE_KIND ?? "").trim()
  if (!new Set(["personal", "company"]).has(profile))
    throw new Error("PROFILE_KIND must be personal or company")
  const outputDirectory = resolve(process.argv[2] ?? "assets/metrics")

  const inspected = []
  for (const repository of repositories)
    inspected.push(await inspectRepository(repository, token))

  await mkdir(outputDirectory, {recursive: true})
  await Promise.all([
    writeFile(resolve(outputDirectory, "engineering-signal-light.svg"), renderSignal(inspected, {theme: "light", label, profile}), {encoding: "utf8", mode: 0o644}),
    writeFile(resolve(outputDirectory, "engineering-signal-dark.svg"), renderSignal(inspected, {theme: "dark", label, profile}), {encoding: "utf8", mode: 0o644}),
    writeFile(resolve(outputDirectory, "engineering-signal-mobile-light.svg"), renderSignal(inspected, {theme: "light", label, profile, layout: "mobile"}), {encoding: "utf8", mode: 0o644}),
    writeFile(resolve(outputDirectory, "engineering-signal-mobile-dark.svg"), renderSignal(inspected, {theme: "dark", label, profile, layout: "mobile"}), {encoding: "utf8", mode: 0o644}),
  ])
}

if (process.argv[1] && (import.meta.url === pathToFileURL(resolve(process.argv[1])).href))
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
