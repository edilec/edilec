import {mkdir, writeFile} from "node:fs/promises"
import {resolve} from "node:path"

const API_ORIGIN = "https://api.github.com"
const PROFILE_LOGIN = process.env.PROFILE_LOGIN
const PROFILE_LABEL = process.env.PROFILE_LABEL ?? PROFILE_LOGIN
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const OUTPUT_DIRECTORY = resolve(process.argv[2] ?? "assets/profile")

if (!PROFILE_LOGIN)
  throw new Error("PROFILE_LOGIN is required")
if (!TOKEN)
  throw new Error("GITHUB_TOKEN or GH_TOKEN is required")

const XML_ESCAPE = value => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;")

function request(path, options = {}) {
  return fetch(`${API_ORIGIN}${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "edilec-local-profile-assets",
      "x-github-api-version": "2022-11-28",
      ...(options.headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }).then(async response => {
    const body = await response.json()
    if (!response.ok)
      throw new Error(`GitHub API request failed with status ${response.status}`)
    return body
  })
}

async function loadProfile() {
  const [profile, contributionResponse] = await Promise.all([
    request(`/users/${encodeURIComponent(PROFILE_LOGIN)}`),
    loadContributions(),
  ])
  return {profile, contributions: contributionResponse}
}

async function loadContributions() {
  const end = new Date()
  end.setUTCHours(23, 59, 59, 999)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 365)
  start.setUTCHours(0, 0, 0, 0)
  const query = `
    query($login:String!, $from:DateTime!, $to:DateTime!) {
      user(login:$login) {
        contributionsCollection(from:$from, to:$to) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
                weekday
                contributionLevel
              }
            }
          }
        }
      }
    }
  `
  const response = await request("/graphql", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      query,
      variables: {
        login: PROFILE_LOGIN,
        from: start.toISOString(),
        to: end.toISOString(),
      },
    }),
  })
  if (response.errors?.length)
    throw new Error(response.errors.map(error => error.message).join("; "))
  const collection = response.data?.user?.contributionsCollection
  if (!collection?.contributionCalendar?.weeks?.length)
    throw new Error(`No contribution calendar returned for ${PROFILE_LOGIN}`)
  return {collection, start, end}
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)
}

function fontFamily() {
  return "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
}

const CONTRIBUTION_THEMES = {
  light: {
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#57606a",
    accent: "#0969da",
    separator: "#d8dee4",
    levels: ["#f6f8fa", "#d8f3e0", "#9be9a8", "#40c463", "#216e39"],
  },
  dark: {
    border: "#30363d",
    text: "#e6edf3",
    muted: "#8b949e",
    accent: "#58a6ff",
    separator: "#21262d",
    levels: ["#21262d", "#0e4429", "#006d32", "#26a641", "#39d353"],
  },
}

function shadeHex(hex, factor) {
  const value = hex.slice(1)
  if (!/^[0-9a-f]{6}$/i.test(value))
    return hex
  const channels = value.match(/.{2}/g).map(channel => Math.round(parseInt(channel, 16) * factor))
  return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`
}

function contributionLevelIndex(level) {
  return {
    NONE: 0,
    FIRST_QUARTILE: 1,
    SECOND_QUARTILE: 2,
    THIRD_QUARTILE: 3,
    FOURTH_QUARTILE: 4,
  }[level] ?? 0
}

function contributionCube({x, y, size, height, palette, title}) {
  const depth = 4
  const p1 = [x, y + depth]
  const p2 = [x + size, y]
  const p3 = [x + size + depth, y + depth]
  const p4 = [x + depth, y + depth * 2]
  const points = pointsList => pointsList.map(([pointX, pointY]) => `${pointX},${pointY}`).join(" ")
  const tooltip = `<title>${XML_ESCAPE(title)}</title>`
  const top = `<polygon points="${points([p1, p2, p3, p4])}" fill="${palette.top}" stroke="${palette.stroke}" stroke-width="0.8"/>`
  if (height === 0)
    return `<g>${tooltip}${top}</g>`

  const left = [p1, p4, [p4[0], p4[1] + height], [p1[0], p1[1] + height]]
  const right = [p4, p3, [p3[0], p3[1] + height], [p4[0], p4[1] + height]]
  return `<g>${tooltip}
    <polygon points="${points(left)}" fill="${palette.left}" stroke="${palette.stroke}" stroke-width="0.8"/>
    <polygon points="${points(right)}" fill="${palette.right}" stroke="${palette.stroke}" stroke-width="0.8"/>
    ${top}
  </g>`
}

function renderContributionCalendar3D({profile, collection, end, mode}) {
  const theme = CONTRIBUTION_THEMES[mode]
  const calendar = collection.contributionCalendar
  const weeks = calendar.weeks
  const firstDay = weeks[0].contributionDays[0]
  const levels = theme.levels.map(top => ({
    top,
    left: shadeHex(top, 0.82),
    right: shadeHex(top, 0.64),
    stroke: theme.border,
  }))
  const heights = [0, 4, 8, 12, 17]
  const gridX = 312
  const gridY = 158
  const cells = []
  const monthLabels = []

  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex]
    for (const day of week.contributionDays) {
      const weekday = Number(day.weekday)
      const level = contributionLevelIndex(day.contributionLevel)
      const x = gridX + weekIndex * 16
      const y = gridY + weekIndex * 0.5 + weekday * 18
      cells.push(contributionCube({
        x,
        y,
        size: 12,
        height: heights[level],
        palette: levels[level],
        title: `${day.contributionCount} contributions on ${day.date}`,
      }))
      if (day.date.endsWith("-01"))
        monthLabels.push(`<text x="${x - 2}" y="143" fill="${theme.muted}" font-family="${fontFamily()}" font-size="10">${XML_ESCAPE(new Intl.DateTimeFormat("en-GB", {month: "short", timeZone: "UTC"}).format(new Date(`${day.date}T00:00:00Z`)))}</text>`)
    }
  }

  const summary = calendar.totalContributions
  const metricRows = [
    [profile.public_repos, "public repositories"],
    [collection.totalCommitContributions, "commits"],
    [collection.totalPullRequestContributions, "pull requests"],
    [collection.totalPullRequestReviewContributions, "reviews"],
  ].map(([value, label], index) => {
    const y = 190 + index * 36
    return `<g>
      <rect x="36" y="${y - 14}" width="4" height="20" rx="2" fill="${theme.accent}"/>
      <text x="54" y="${y}" fill="${theme.text}" font-family="${fontFamily()}" font-size="18" font-weight="750">${XML_ESCAPE(value)}</text>
      <text x="88" y="${y}" fill="${theme.muted}" font-family="${fontFamily()}" font-size="13">${XML_ESCAPE(label)}</text>
    </g>`
  }).join("")
  const legend = theme.levels.map((color, index) => `<rect x="${gridX + 72 + index * 18}" y="392" width="12" height="12" rx="3" fill="${color}" stroke="${theme.border}" stroke-width="0.7"/>`).join("")
  const startLabel = formatDate(new Date(`${firstDay.date}T00:00:00Z`))
  const endLabel = formatDate(end)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 420" width="1200" height="420" role="img" aria-labelledby="calendar-3d-title calendar-3d-desc" data-component="contribution-calendar-3d" data-schema="1" data-profile="${XML_ESCAPE(PROFILE_LOGIN)}" data-theme="${mode}" data-as-of="${XML_ESCAPE(end.toISOString())}" data-total="${XML_ESCAPE(summary)}">
  <title id="calendar-3d-title">${XML_ESCAPE(PROFILE_LABEL)} open-source contribution activity</title>
  <desc id="calendar-3d-desc">A locally stored three-dimensional contribution calendar for the last year, with ${XML_ESCAPE(summary)} contributions from ${XML_ESCAPE(startLabel)} through ${XML_ESCAPE(endLabel)}.</desc>
  <rect x="1" y="1" width="1198" height="418" rx="18" fill="none" stroke="${theme.border}" stroke-width="2"/>
  <text x="36" y="42" fill="${theme.accent}" font-family="${fontFamily()}" font-size="11" font-weight="750" letter-spacing="2">GITHUB CONTRIBUTIONS</text>
  <text x="36" y="78" fill="${theme.text}" font-family="${fontFamily()}" font-size="26" font-weight="750">${XML_ESCAPE(summary)} contributions in the last year</text>
  <text x="36" y="104" fill="${theme.muted}" font-family="${fontFamily()}" font-size="12">${XML_ESCAPE(startLabel)} – ${XML_ESCAPE(endLabel)} · public activity from ${XML_ESCAPE(PROFILE_LABEL)}</text>
  <line x1="276" y1="132" x2="276" y2="366" stroke="${theme.separator}" stroke-width="1"/>
  <text x="36" y="143" fill="${theme.muted}" font-family="${fontFamily()}" font-size="11" font-weight="750" letter-spacing="1.5">OPEN-SOURCE SIGNALS</text>
  ${metricRows}
  <text x="${gridX}" y="126" fill="${theme.muted}" font-family="${fontFamily()}" font-size="11" font-weight="750" letter-spacing="1.5">ACTIVITY BY WEEK</text>
  <text x="1164" y="126" text-anchor="end" fill="${theme.muted}" font-family="${fontFamily()}" font-size="11">52 weeks</text>
  ${monthLabels.join("")}
  ${cells.join("")}
  <text x="${gridX}" y="402" fill="${theme.muted}" font-family="${fontFamily()}" font-size="11">Less</text>
  ${legend}
  <text x="${gridX + 176}" y="402" fill="${theme.muted}" font-family="${fontFamily()}" font-size="11">More</text>
</svg>
`
}

function metricCard(x, label, value) {
  return `<g>
    <rect x="${x}" y="94" width="264" height="94" rx="14" fill="#ffffff" stroke="#d0d7de"/>
    <text x="${x + 18}" y="123" fill="#57606a" font-family="${fontFamily()}" font-size="11" font-weight="700" letter-spacing="1.2">${XML_ESCAPE(label)}</text>
    <text x="${x + 18}" y="160" fill="#116329" font-family="${fontFamily()}" font-size="28" font-weight="750">${XML_ESCAPE(value)}</text>
  </g>`
}

function renderActivity({profile, collection, end}) {
  const summary = collection.contributionCalendar
  const values = [
    ["PUBLIC REPOSITORIES", profile.public_repos],
    ["CONTRIBUTIONS", summary.totalContributions],
    ["COMMITS", collection.totalCommitContributions],
    ["PULL REQUESTS", collection.totalPullRequestContributions],
  ]
  const cards = values.map(([label, value], index) => metricCard(36 + index * 282, label, value)).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 250" width="1200" height="250" role="img" aria-labelledby="activity-title activity-desc" data-component="github-activity" data-schema="1" data-profile="${XML_ESCAPE(PROFILE_LOGIN)}" data-as-of="${XML_ESCAPE(end.toISOString())}">
  <title id="activity-title">${XML_ESCAPE(PROFILE_LABEL)} GitHub activity</title>
  <desc id="activity-desc">A local snapshot of public repositories and GitHub contributions through ${XML_ESCAPE(formatDate(end))}.</desc>
  <rect x=".5" y=".5" width="1199" height="249" rx="18" fill="#f6f8fa" stroke="#d0d7de"/>
  <text x="36" y="37" fill="#116329" font-family="${fontFamily()}" font-size="11" font-weight="750" letter-spacing="2">GITHUB ACTIVITY</text>
  <text x="36" y="67" fill="#1f2328" font-family="${fontFamily()}" font-size="24" font-weight="750">${XML_ESCAPE(PROFILE_LABEL)} · local profile signal</text>
  ${cards}
  <text x="36" y="221" fill="#57606a" font-family="${fontFamily()}" font-size="12">Generated from GitHub account data on ${XML_ESCAPE(formatDate(end))}. The image is stored in this profile repository.</text>
</svg>
`
}

function levelColor(level) {
  return {
    NONE: "#ebedf0",
    FIRST_QUARTILE: "#d7f0df",
    SECOND_QUARTILE: "#a8dfb8",
    THIRD_QUARTILE: "#55b878",
    FOURTH_QUARTILE: "#1f883d",
  }[level] ?? "#ebedf0"
}

function renderContributionGrid({collection, end}) {
  const calendar = collection.contributionCalendar
  const weeks = calendar.weeks
  const gridX = 36
  const gridY = 144
  const stride = 16
  const cell = 12
  const cells = []
  const monthLabels = []
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const week = weeks[weekIndex]
    for (const day of week.contributionDays) {
      const x = gridX + weekIndex * stride
      const y = gridY + Number(day.weekday) * stride
      cells.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${levelColor(day.contributionLevel)}"><title>${XML_ESCAPE(day.contributionCount)} contributions on ${XML_ESCAPE(day.date)}</title></rect>`)
      if (day.date.endsWith("-01"))
        monthLabels.push(`<text x="${x}" y="132" fill="#57606a" font-family="${fontFamily()}" font-size="10">${XML_ESCAPE(new Intl.DateTimeFormat("en-GB", {month: "short", timeZone: "UTC"}).format(new Date(`${day.date}T00:00:00Z`)))}</text>`)
    }
  }

  const legend = ["NONE", "FIRST_QUARTILE", "SECOND_QUARTILE", "THIRD_QUARTILE", "FOURTH_QUARTILE"]
    .map((level, index) => `<rect x="${966 + index * 18}" y="278" width="12" height="12" rx="2" fill="${levelColor(level)}"/>`).join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 310" width="1200" height="310" role="img" aria-labelledby="grid-title grid-desc" data-component="contribution-grid" data-schema="1" data-profile="${XML_ESCAPE(PROFILE_LOGIN)}" data-as-of="${XML_ESCAPE(end.toISOString())}" data-total="${XML_ESCAPE(calendar.totalContributions)}">
  <title id="grid-title">${XML_ESCAPE(PROFILE_LABEL)} contribution activity</title>
  <desc id="grid-desc">A locally stored contribution calendar covering the last year through ${XML_ESCAPE(formatDate(end))}, with ${XML_ESCAPE(calendar.totalContributions)} contributions.</desc>
  <rect x=".5" y=".5" width="1199" height="309" rx="18" fill="#ffffff" stroke="#d0d7de"/>
  <text x="36" y="37" fill="#116329" font-family="${fontFamily()}" font-size="11" font-weight="750" letter-spacing="2">CONTRIBUTION CALENDAR</text>
  <text x="36" y="68" fill="#1f2328" font-family="${fontFamily()}" font-size="24" font-weight="750">${XML_ESCAPE(calendar.totalContributions)} contributions in the last year</text>
  <text x="36" y="91" fill="#57606a" font-family="${fontFamily()}" font-size="12">${XML_ESCAPE(formatDate(new Date(calendar.weeks[0].contributionDays[0].date)))} – ${XML_ESCAPE(formatDate(end))} · stored locally for dependable loading</text>
  ${monthLabels.join("")}
  ${cells.join("")}
  <text x="36" y="300" fill="#57606a" font-family="${fontFamily()}" font-size="11">Less</text>
  ${legend}
  <text x="1063" y="288" fill="#57606a" font-family="${fontFamily()}" font-size="11">More</text>
</svg>
`
}

async function main() {
  const {profile, contributions} = await loadProfile()
  const {collection, end} = contributions
  await mkdir(OUTPUT_DIRECTORY, {recursive: true})
  const assets = process.env.ONLY_3D === "1"
    ? {
        "contribution-calendar-3d.svg": renderContributionCalendar3D({profile, collection, end, mode: "light"}),
        "contribution-calendar-3d-dark.svg": renderContributionCalendar3D({profile, collection, end, mode: "dark"}),
      }
    : {
        "github-activity-light.svg": renderActivity({profile, collection, end}),
        "contribution-grid-light.svg": renderContributionGrid({collection, end}),
      }
  await Promise.all(Object.entries(assets).map(([name, contents]) => writeFile(resolve(OUTPUT_DIRECTORY, name), contents)))
  console.log(JSON.stringify({
    profile: PROFILE_LOGIN,
    totalContributions: collection.contributionCalendar.totalContributions,
    publicRepositories: profile.public_repos,
    updated: end.toISOString(),
    files: Object.keys(assets),
  }))
}

await main()
